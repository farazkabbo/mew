"""Fine-tunes Mew v2, the gate classifier that runs in the browser (brief §4, M10).

    uv run python train.py --data data --model distilbert-base-uncased --export \
        ../frontend/public/workers/models/mew-gate

Input: the JSONL splits from `python -m mew_api.dataset` (text, label). Output: a fine-tuned model,
exported to ONNX and quantized to int8, laid out for transformers.js (config.json, tokenizer
files, onnx/model_quantized.onnx), plus mew.json: the feature version and the confidence above
which the browser may trust it (below it, the v1 gate decides).
"""

import argparse
import json
import random
import shutil
import time
from pathlib import Path
from typing import Any

import numpy as np
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from torch.utils.data import DataLoader
from transformers import AutoModelForSequenceClassification, AutoTokenizer

#: The precision the browser's answers must reach on the validation split.
TARGET_PRECISION = 0.95
MAX_LENGTH = 128


def read_split(data: Path, name: str) -> list[dict[str, str]]:
    path = data / f"{name}.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data"))
    parser.add_argument("--model", default="distilbert-base-uncased")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=Path, default=Path("output/mew-gate"))
    parser.add_argument("--export", type=Path, help="copy the browser model here")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    meta = json.loads((args.data / "meta.json").read_text(encoding="utf-8"))
    labels: list[str] = meta["labels"]
    label_id = {label: i for i, label in enumerate(labels)}
    splits = {name: read_split(args.data, name) for name in ("train", "val", "test")}
    print({name: len(rows) for name, rows in splits.items()}, "examples")
    if not splits["train"]:
        raise SystemExit("No training examples: export a dataset first.")

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=len(labels),
        id2label=dict(enumerate(labels)),
        label2id=label_id,
    )

    def batches(rows: list[dict[str, str]], shuffle: bool) -> DataLoader[Any]:
        def collate(batch: list[dict[str, str]]) -> dict[str, torch.Tensor]:
            encoded = tokenizer(
                [r["text"] for r in batch],
                truncation=True,
                max_length=MAX_LENGTH,
                padding=True,
                return_tensors="pt",
            )
            encoded["labels"] = torch.tensor([label_id[r["label"]] for r in batch])
            return dict(encoded)

        return DataLoader(rows, batch_size=args.batch, shuffle=shuffle, collate_fn=collate)  # type: ignore[arg-type]

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for batch in batches(splits["train"], shuffle=True):
            loss = model(**batch).loss
            loss.backward()
            optimizer.step()
            optimizer.zero_grad()
            total += float(loss)
        print(f"epoch {epoch + 1}: loss {total:.3f}")

    def predict(rows: list[dict[str, str]]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        model.eval()
        confidence, predicted, truth = [], [], []
        with torch.no_grad():
            for batch in batches(rows, shuffle=False):
                gold = batch.pop("labels")
                probs = torch.softmax(model(**batch).logits, dim=-1)
                best = probs.max(dim=-1)
                confidence += best.values.tolist()
                predicted += best.indices.tolist()
                truth += gold.tolist()
        return np.array(confidence), np.array(predicted), np.array(truth)

    # The threshold: the lowest confidence at which validation answers are precise enough.
    min_confidence = 1.0
    calibration = splits["val"] or splits["train"]
    conf, pred, gold = predict(calibration)
    for threshold in np.arange(0.5, 1.0, 0.01):
        sure = conf >= threshold
        if sure.sum() >= 3 and (pred[sure] == gold[sure]).mean() >= TARGET_PRECISION:
            min_confidence = float(round(threshold, 2))
            break
    report: dict[str, Any] = {"min_confidence": min_confidence}
    for name in ("val", "test"):
        if splits[name]:
            conf, pred, gold = predict(splits[name])
            sure = conf >= min_confidence
            report[name] = {
                "accuracy": round(float((pred == gold).mean()), 3),
                "coverage": round(float(sure.mean()), 3),
                "precision_when_sure": round(float((pred[sure] == gold[sure]).mean()), 3)
                if sure.any()
                else None,
            }
    print(json.dumps(report, indent=2))

    # Save, export to ONNX (int8) and lay out for transformers.js.
    args.out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(args.out)
    tokenizer.save_pretrained(args.out)
    onnx_dir = args.out / "onnx"
    onnx_dir.mkdir(exist_ok=True)
    sample = tokenizer(["is this right?"], return_tensors="pt")
    names = list(sample.keys())
    model.eval()
    torch.onnx.export(
        model,
        (dict(sample),),
        onnx_dir / "model.onnx",
        input_names=names,
        output_names=["logits"],
        dynamic_axes={**{n: {0: "batch", 1: "sequence"} for n in names}, "logits": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    quantize_dynamic(
        onnx_dir / "model.onnx", onnx_dir / "model_quantized.onnx", weight_type=QuantType.QInt8
    )
    (args.out / "mew.json").write_text(
        json.dumps(
            {
                "features": meta["features"],
                "labels": labels,
                "min_confidence": min_confidence,
                "base_model": args.model,
                "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "report": report,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    if args.export:
        if args.export.exists():
            shutil.rmtree(args.export)
        (args.export / "onnx").mkdir(parents=True)
        for item in ("config.json", "mew.json", "tokenizer.json", "tokenizer_config.json"):
            shutil.copy(args.out / item, args.export / item)
        for optional in ("special_tokens_map.json", "vocab.txt"):
            if (args.out / optional).exists():
                shutil.copy(args.out / optional, args.export / optional)
        shutil.copy(onnx_dir / "model_quantized.onnx", args.export / "onnx")
        print(f"browser model -> {args.export}")


if __name__ == "__main__":
    main()

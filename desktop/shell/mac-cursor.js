"use strict";
const canvas = document.getElementById("scene");
window.addEventListener("mew:mac-cursor-scene", ({ detail }) => {
  if (!canvas || !detail || !Array.isArray(detail.shapes) || detail.shapes.length > 64) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2;
  ctx.font = "14px system-ui";
  for (const shape of detail.shapes) {
    const finite = (...v) =>
      v.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e7);
    if (shape.type === "path" && finite(...shape.from, ...shape.control, ...shape.to)) {
      ctx.strokeStyle = "#9474e6";
      ctx.globalAlpha = shape.alpha;
      ctx.beginPath();
      ctx.moveTo(...shape.from);
      ctx.quadraticCurveTo(...shape.control, ...shape.to);
      ctx.stroke();
    } else if (shape.type === "glow" && finite(shape.x, shape.y, shape.w, shape.h, shape.scale)) {
      ctx.globalAlpha = shape.alpha;
      ctx.strokeStyle = shape.warn ? "#d79936" : "#9474e6";
      ctx.lineWidth = 4;
      const w = shape.w * shape.scale,
        h = shape.h * shape.scale;
      ctx.strokeRect(shape.x + (shape.w - w) / 2, shape.y + (shape.h - h) / 2, w, h);
    } else if (
      shape.type === "caption" &&
      finite(shape.x, shape.y) &&
      typeof shape.text === "string"
    ) {
      ctx.globalAlpha = 1;
      const text = shape.text.slice(0, 300);
      ctx.fillStyle = shape.warn ? "#fff3dc" : "#f0eafa";
      ctx.fillRect(shape.x, shape.y, Math.min(ctx.measureText(text).width + 20, 360), 32);
      ctx.fillStyle = "#372d4b";
      ctx.fillText(text, shape.x + 10, shape.y + 21, 340);
    } else if (
      (shape.type === "dot" || shape.type === "ring") &&
      finite(shape.x, shape.y, shape.radius)
    ) {
      ctx.globalAlpha = shape.alpha || 1;
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, Math.max(0, shape.radius), 0, 2 * Math.PI);
      ctx.strokeStyle = "#9474e6";
      ctx.fillStyle = "#9474e6";
      shape.type === "dot" ? ctx.fill() : ctx.stroke();
    }
  }
});

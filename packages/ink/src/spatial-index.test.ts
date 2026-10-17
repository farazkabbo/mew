import { describe, expect, it } from "vitest";

import { SpatialIndex } from "./spatial-index";

describe("SpatialIndex", () => {
  it("finds items sharing cells with the query and not distant ones", () => {
    const index = new SpatialIndex(100);
    index.insert("near", [10, 10, 5, 5]);
    index.insert("far", [1000, 1000, 5, 5]);

    expect([...index.query([0, 0, 50, 50])]).toEqual(["near"]);
  });

  it("finds items that span several cells", () => {
    const index = new SpatialIndex(100);
    index.insert("wide", [0, 0, 450, 10]);

    expect(index.query([420, 0, 5, 5]).has("wide")).toBe(true);
  });

  it("re-inserting moves an item", () => {
    const index = new SpatialIndex(100);
    index.insert("a", [0, 0, 5, 5]);
    index.insert("a", [500, 500, 5, 5]);

    expect(index.query([0, 0, 10, 10]).has("a")).toBe(false);
    expect(index.query([500, 500, 10, 10]).has("a")).toBe(true);
    expect(index.size).toBe(1);
  });

  it("removes items", () => {
    const index = new SpatialIndex(100);
    index.insert("a", [0, 0, 5, 5]);
    index.remove("a");

    expect(index.query([0, 0, 10, 10]).size).toBe(0);
    expect(index.size).toBe(0);
  });

  it("handles huge boxes without enumerating millions of cells", () => {
    const index = new SpatialIndex(1);
    index.insert("huge", [0, 0, 1e6, 1e6]);
    index.insert("tiny", [5, 5, 0, 0]);

    expect(index.query([999_000, 999_000, 1, 1]).has("huge")).toBe(true);
    expect(index.query([-1e9, -1e9, 2e9, 2e9])).toEqual(new Set(["huge", "tiny"]));
  });

  it("works with negative coordinates", () => {
    const index = new SpatialIndex(100);
    index.insert("neg", [-250, -250, 10, 10]);

    expect(index.query([-260, -260, 20, 20]).has("neg")).toBe(true);
  });
});

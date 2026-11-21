import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CUSTOM_PANEL_RESULTS,
  parseRequestedResultCount,
  verifiedResultCount,
  verifiedSortDirection
} from "../lib/panelRanking";

test("understands digit and written ranking sizes", () => {
  assert.deepEqual(parseRequestedResultCount("my top five products"), {count:5,mode:"top"});
  assert.deepEqual(parseRequestedResultCount("Top-5 products by revenue"), {count:5,mode:"top"});
  assert.deepEqual(parseRequestedResultCount("show the top 10 regions"), {count:10,mode:"top"});
  assert.deepEqual(parseRequestedResultCount("bottom three categories"), {count:3,mode:"bottom"});
  assert.deepEqual(parseRequestedResultCount("top twenty five products"), {count:25,mode:"top"});
});

test("supports dated windows and does not invent an unspecified count", () => {
  assert.deepEqual(parseRequestedResultCount("latest six months revenue"), {count:6,mode:"recent"});
  assert.deepEqual(parseRequestedResultCount("last 3 months"), {count:3,mode:"recent"});
  assert.equal(parseRequestedResultCount("revenue by product category"), null);
});

test("rejects counts above the backend limit rather than silently truncating", () => {
  assert.throws(() => parseRequestedResultCount("top 31 products"), /between 1 and/);
  assert.throws(() => parseRequestedResultCount("top 99 products"), /between 1 and/);
  assert.equal(MAX_CUSTOM_PANEL_RESULTS, 30);
});

test("validates stored panel limits and sorting on refresh", () => {
  assert.equal(verifiedResultCount(5,12),5);
  assert.equal(verifiedResultCount(undefined,12),12);
  assert.equal(verifiedResultCount(30,12),30);
  assert.throws(() => verifiedResultCount(50,12),/invalid result limit/);
  assert.throws(() => verifiedResultCount("5",12),/invalid result limit/);
  assert.equal(verifiedSortDirection(undefined),"desc");
  assert.equal(verifiedSortDirection("asc"),"asc");
  assert.throws(() => verifiedSortDirection("random"),/invalid sorting/);
});

"use strict";

const validCount = value => Number.isSafeInteger(value) && value >= 0;
const validCounters = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) && validCount(value.org) && validCount(value.repo);

// A proven OFF takes precedence when another counter has rolled back.
function compareCounters(current, seen) {
  if (current.org > seen.org || current.repo > seen.repo) return "higher";
  if (current.org < seen.org || current.repo < seen.repo) return "lower";
  return "equal";
}

module.exports = { validCount, validCounters, compareCounters };

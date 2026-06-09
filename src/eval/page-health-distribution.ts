/**
 * Page-level health distribution evaluator for the llmwiki eval harness.
 *
 * While the corpus-level health score aggregates all lint findings into one
 * 0-100 number, this evaluator breaks it down per page so maintainers can
 * see *which* pages need attention — not just that *something* is wrong.
 *
 * Reports:
 *  - distribution: count of pages in each health tier
 *  - perPage: every page with its individual score, tier, and top issues
 *  - worstPages: lowest-scoring N pages (default 5)
 *
 * Scoring: reuses the same deductionFor() from health.ts so per-page scores
 * are consistent with the overall health score. A page's score equals the
 * health score it would receive if it were the only page in the wiki.
 *
 * Tiers:
 *  - healthy:    90-100
 *  - adequate:   70-89
 *  - needs_work: 50-69
 *  - broken:     0-49
 *
 * Design note: runAllLintRules is called independently of evaluateHealth.
 * This means lint rules run twice per eval (once here, once in evaluateHealth).
 * The cost is pure file I/O with no LLM calls. This is an intentional trade-off
 * to keep evaluateHealth's API unchanged. If it becomes a bottleneck, a shared
 * in-memory cache layer can be introduced without changing either public API.
 */

import path from "path";
import { collectAllPages } from "../linter/rules.js";
import { runAllLintRules, deductionFor } from "./health.js";
import type { LintResult } from "../linter/types.js";
import type { PageHealthDistributionResult, PageHealthEntry } from "./types.js";

const MAX_SCORE = 100;

/** Map a score to its health tier. */
function tierFor(score: number): PageHealthEntry["tier"] {
  if (score >= 90) return "healthy";
  if (score >= 70) return "adequate";
  if (score >= 50) return "needs_work";
  return "broken";
}

/** Collect the top 3 most frequent issue rule-names for a list of findings. */
function topIssues(findings: LintResult[]): string[] {
  const counts = new Map<string, number>();
  for (const f of findings) {
    counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([rule, count]) => count > 1 ? rule + " x" + count : rule);
}

/**
 * Evaluate per-page health across all wiki pages.
 * @param root - Absolute path to the project root.
 * @param worstPageCount - How many worst pages to return (default 5).
 */
export async function evaluatePageHealthDistribution(
  root: string,
  worstPageCount = 5,
): Promise<PageHealthDistributionResult> {
  const [allResults, pages] = await Promise.all([
    runAllLintRules(root),
    collectAllPages(root),
  ]);

  // Group findings by page file path
  const findingsByPath = new Map<string, LintResult[]>();
  for (const r of allResults) {
    const existing = findingsByPath.get(r.file);
    if (existing) existing.push(r);
    else findingsByPath.set(r.file, [r]);
  }

  // Ensure every page appears (zero-finding pages score 100)
  for (const { filePath } of pages) {
    if (!findingsByPath.has(filePath)) {
      findingsByPath.set(filePath, []);
    }
  }

  // Compute per-page scores
  const perPage: PageHealthEntry[] = [];
  for (const [filePath, findings] of findingsByPath) {
    const slug = path.basename(path.dirname(filePath)) + "/" + path.basename(filePath, ".md");
    const totalDeduction = findings.reduce((sum, r) => sum + deductionFor(r), 0);
    const score = Math.max(0, MAX_SCORE - totalDeduction);
    const tier = tierFor(score);
    perPage.push({ slug, score, tier, topIssues: topIssues(findings) });
  }

  // Sort ascending (worst first)
  perPage.sort((a, b) => a.score - b.score);

  const distribution = {
    healthy: perPage.filter((p) => p.tier === "healthy").length,
    adequate: perPage.filter((p) => p.tier === "adequate").length,
    needsWork: perPage.filter((p) => p.tier === "needs_work").length,
    broken: perPage.filter((p) => p.tier === "broken").length,
  };

  return {
    distribution,
    perPage,
    worstPages: perPage.slice(0, worstPageCount),
  };
}

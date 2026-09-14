import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { artifactsForDailyKpis, KpiRouter, LocalKpiSink, objectPrefixForDate, parseSinkList } from "../src/export/kpiRouter.js";
import { cleanup, makeTempDir } from "./helpers.js";

const temp = makeTempDir("evals-kpi-router-");
try {
  const artifacts = artifactsForDailyKpis({
    jsonFileName: "agent-kpis-2026-05-04.json",
    json: "{\"ok\":true}\n",
    markdownFileName: "agent-kpis-2026-05-04.md",
    markdown: "# KPIs\n"
  });
  const outputDir = path.join(temp, "out");
  const results = await new KpiRouter([new LocalKpiSink(outputDir)]).write(artifacts);

  assert.deepEqual(parseSinkList("local,gcs"), ["local", "gcs"]);
  assert.equal(objectPrefixForDate("2026-05-04"), "daily/2026/05/04");
  assert.equal(results[0]?.sink, "local");
  assert.equal(results[0]?.destinations.length, 2);
  assert.equal(fs.readFileSync(path.join(outputDir, "agent-kpis-2026-05-04.json"), "utf8"), "{\"ok\":true}\n");
  assert.equal(fs.readFileSync(path.join(outputDir, "agent-kpis-2026-05-04.md"), "utf8"), "# KPIs\n");
} finally {
  cleanup(temp);
}

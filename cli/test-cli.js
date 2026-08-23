const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cli = require("./cli.js");

test("OpenAI pricing separates uncached, cached, cache-write and output tokens", () => {
  assert.equal(cli.openAIPriceFor("gpt-5.6-luna-2026-08-01").in, 1);
  assert.deepEqual(cli.openAIPriceFor("gpt-5.6-terra"), { in: 2.5, cached: 0.25, write: 3.125, out: 15 });
  assert.equal(cli.openAIPriceFor("gpt-5.6-sol").out, 30);
  const cost = cli.openAICostFromUsage(
    {
      input_tokens: 1000,
      cached_input_tokens: 600,
      cache_write_input_tokens: 100,
      output_tokens: 100,
    },
    "gpt-5.6-luna"
  );
  assert.equal(cost, (300 * 1 + 600 * 0.1 + 100 * 1.25 + 100 * 6) / 1e6);
});

test("Claude Sonnet 5 introductory pricing ends in September 2026", () => {
  assert.deepEqual(cli.priceFor("claude-sonnet-5", Date.UTC(2026, 7, 31)), { in: 2, out: 10 });
  assert.deepEqual(cli.priceFor("claude-sonnet-5", Date.UTC(2026, 8, 1)), { in: 3, out: 15 });
});

test("Codex cumulative counters are converted to per-event deltas", () => {
  assert.deepEqual(
    cli.usageDelta(
      { input_tokens: 1500, cached_input_tokens: 1100, output_tokens: 180 },
      { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 }
    ),
    {
      input_tokens: 500,
      cached_input_tokens: 300,
      cache_write_input_tokens: 0,
      output_tokens: 80,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    }
  );
});

test("report payload identifies the absolute counter for server-side rebasing", () => {
  const payload = cli.buildPayload(
    { username: "mel", key: "secret", shareSetup: false },
    { seasonId: 1, tokens: 100, cost: 2, residents: 3, buildings: 4, daily: {} }
  );
  assert.equal(payload.counterId, cli.COUNTER_ID);
  assert.equal(payload.counterId, "cli-aggregate-v1");
});

test("one season combines Claude Code and Codex without prompt content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokentown-test-"));
  try {
    const claudeDir = path.join(root, ".claude", "projects", "fixture");
    const codexDir = path.join(root, ".codex", "sessions", "2026", "08", "10");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "session.jsonl"),
      JSON.stringify({
        timestamp: "2026-08-10T12:00:00.000Z",
        requestId: "req-1",
        message: {
          id: "msg-1",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30 },
          content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: {} }],
        },
      }) + "\n"
    );
    const codexRows = [
      { timestamp: "2026-08-10T12:00:00.000Z", type: "session_meta", payload: { source: { subagent: "worker" } } },
      { timestamp: "2026-08-10T12:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.6-luna" } },
      { timestamp: "2026-08-10T12:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 } } } },
      { timestamp: "2026-08-10T12:00:03.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 1100, output_tokens: 180 } } } },
    ];
    fs.writeFileSync(path.join(codexDir, "session.jsonl"), codexRows.map(JSON.stringify).join("\n") + "\n");

    const data = cli.readSeason(Date.UTC(2026, 7, 14), { home: root, opencode: false });
    assert.equal(data.tokens, 730);
    assert.equal(data.residents, 2);
    assert.deepEqual(data.sources, { claude: 1, codex: 1, opencode: 0 });
    assert.deepEqual(data.modelBreakdown.map((row) => row.model).sort(), ["claude-sonnet-4-5", "gpt-5.6-luna"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launchd schedule is self-contained and runs every ten minutes", () => {
  const plist = cli.schedulePlist(
    { runner: "/tmp/token&town/cli.js", log: "/tmp/token&town/reporter.log" },
    "/tmp/config&file.json"
  );
  assert.match(plist, /<key>StartInterval<\/key><integer>600<\/integer>/);
  assert.match(plist, /token&amp;town/);
  assert.match(plist, /config&amp;file\.json/);
  assert.doesNotMatch(plist, /npx|watch/);
});

test("Linux systemd schedule is persistent and runs every ten minutes", () => {
  const paths = { runner: "/home/mel/.tokentown/runner/cli.js" };
  const service = cli.scheduleSystemdService(paths, "/home/mel/config.json", "/home/mel", "/usr/bin/node");
  const timer = cli.scheduleSystemdTimer();
  assert.match(service, /Type=oneshot/);
  assert.match(service, /ExecStart="\/usr\/bin\/node" "\/home\/mel\/\.tokentown\/runner\/cli\.js"/);
  assert.match(service, /TOKENTOWN_CONFIG=\/home\/mel\/config\.json/);
  assert.match(timer, /OnUnitActiveSec=10min/);
  assert.match(timer, /Persistent=true/);
});

test("Windows Task Scheduler command uses absolute quoted paths", () => {
  const command = cli.windowsTaskCommand(
    { runner: "C:\\Users\\Mel User\\.tokentown\\runner\\cli.js" },
    "C:\\Program Files\\nodejs\\node.exe"
  );
  assert.equal(command, '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Mel User\\.tokentown\\runner\\cli.js"');
  assert.doesNotMatch(command, /npx|watch/);
});

test("official legacy URL migrates to nort.works without replacing custom endpoints", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nortown-config-test-"));
  try {
    const legacyPath = path.join(root, "legacy.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ username: "mel", key: "secret", url: cli.LEGACY_DEFAULT_URL }));
    const legacy = await cli.loadOrOnboard(legacyPath);
    assert.equal(legacy.cfg.url, cli.DEFAULT_URL);
    assert.equal(JSON.parse(fs.readFileSync(legacyPath, "utf8")).url, "https://nort.works/api/report");

    const customPath = path.join(root, "custom.json");
    fs.writeFileSync(customPath, JSON.stringify({ username: "mel", key: "secret", url: "https://example.test/api/report" }));
    const custom = await cli.loadOrOnboard(customPath);
    assert.equal(custom.cfg.url, "https://example.test/api/report");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

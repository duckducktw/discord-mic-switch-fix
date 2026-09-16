// Offline end-to-end test of the plugin's native enforcement loop.
// Simulates Discord by opening a capture stream whose application.name is
// "WEBRTC VoiceEngine" (exactly what Discord's voice engine registers).
import { execFile, spawn } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const native = await import(process.env.NATIVE_BUNDLE ?? "/tmp/micswitch-native.mjs");

const FAKE_EVENT = {};

async function sh(cmd, args) {
    const { stdout } = await exec(cmd, args);
    return stdout;
}

async function sourceMap() {
    const sources = JSON.parse(await sh("pactl", ["-f", "json", "list", "sources"]));
    return Object.fromEntries(sources.map(s => [s.index, { name: s.name, description: s.description }]));
}

async function discordStream() {
    const outs = JSON.parse(await sh("pactl", ["-f", "json", "list", "source-outputs"]));
    const srcs = await sourceMap();
    return outs
        .filter(o => (o.properties ?? {})["application.name"] === "WEBRTC VoiceEngine")
        .map(o => ({ id: o.index, source: o.source, sourceName: srcs[o.source]?.name, desc: srcs[o.source]?.description }));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- pick two distinct real inputs -------------------------------------------------
const inputs = Object.entries(await sourceMap())
    .filter(([, s]) => !s.name.endsWith(".monitor"));
console.log("available inputs:");
for (const [idx, s] of inputs) console.log(`  #${idx} ${s.description}`);

const byDesc = desc => inputs.find(([, s]) => (s.description ?? "").startsWith(desc));
// start on the Digital Microphone (also the system default), pin to NoiseTorch (definitely not default)
const from = byDesc("Alder Lake") ?? inputs[0];
const to = byDesc("NoiseTorch") ?? inputs[1];
console.log(`\nplan: fake Discord stream starts on ${from[1].description}\n      then pinned to  ${to[1].description}  (non-default source -> unambiguous)`);

// --- start the fake "Discord" capture stream on the *from* source -------------------
const rec = spawn("parec", ["--device=" + from[0], "--client-name=WEBRTC VoiceEngine", "--stream-name=recStream"], {
    stdio: ["ignore", "ignore", "ignore"], detached: false
});
await sleep(1200);

console.log("\n[1] baseline (Discord-equivalent stream, unpinned):");
console.log("   ", await discordStream());

// --- pin --------------------------------------------------------------------------
const res = await native.pinDevice(FAKE_EVENT, to[1].description, false);
console.log("\n[2] pinDevice ->", JSON.stringify(res));

await sleep(1500);
const afterPin = await discordStream();
console.log("    stream now:", afterPin);
const ok1 = afterPin.every(s => s.sourceName === to[1].name);
console.log(ok1 ? "    ✅ stream rerouted to the pinned device" : "    ❌ stream NOT rerouted");

// --- simulate Discord rebuilding the stream on a switch (new stream, wrong source) --
rec.kill();
await sleep(500);
const rec2 = spawn("parec", ["--device=" + from[0], "--client-name=WEBRTC VoiceEngine", "--stream-name=recStream"], {
    stdio: ["ignore", "ignore", "ignore"]
});
await sleep(2000);
const afterRecreate = await discordStream();
console.log("\n[3] Discord recreated its stream back on the wrong source; watcher should catch it:");
console.log("   ", afterRecreate);
const ok2 = afterRecreate.length > 0 && afterRecreate.every(s => s.sourceName === to[1].name);
console.log(ok2 ? "    ✅ re-rerouted automatically (no restart needed)" : "    ❌ watcher missed it");

// --- unknown device -> error, and unpin --------------------------------------------
const bad = await native.pinDevice(FAKE_EVENT, "Nonexistent Microphone 9000", false);
console.log("\n[4] pinDevice(unknown) ->", JSON.stringify(bad));

await native.pinDevice(FAKE_EVENT, null, false);
await sleep(600);
console.log("\n[5] after unpin, stream untouched:", await discordStream());
console.log("\nstatus:", JSON.stringify(await native.getStatus(FAKE_EVENT)).slice(0, 200), "...");

rec2.kill();
await native.unpinDevice(FAKE_EVENT);
console.log(`\nRESULT: reroute=${ok1 ? "PASS" : "FAIL"}  re-enforce=${ok2 ? "PASS" : "FAIL"}`);
process.exit(ok1 && ok2 && !!bad.error ? 0 : 1);

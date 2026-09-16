/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 烤鴨 and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "child_process";
import type { IpcMainInvokeEvent } from "electron";
import { promisify } from "util";

const exec = promisify(execFile);

/**
 * Discord's native voice engine registers its capture stream under this
 * PulseAudio/PipeWire application name.
 */
const DISCORD_CLIENT_NAME = "WEBRTC VoiceEngine";
const DISCORD_BINARY = "Discord";

const POLL_INTERVAL_MS = 400;
const EXEC_TIMEOUT_MS = 5000;

interface PulseSource {
    index: number;
    name: string;
    description?: string;
    state?: string;
}

interface PulseSourceOutput {
    index: number;
    source: number;
    properties?: Record<string, string>;
}

let pinnedSourceName: string | null = null;
let pinnedSourceIndex: number | null = null;
let alsoSetSystemDefault = false;
let savedDefaultSource: string | null = null;
let poller: ReturnType<typeof setInterval> | null = null;
let enforcing = false;

function log(...args: unknown[]) {
    console.log("[MicSwitchFix]", ...args);
}

async function pactl(args: string[]): Promise<string> {
    const { stdout } = await exec("pactl", args, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
    });
    return stdout;
}

async function pactlJson<T>(args: string[]): Promise<T[]> {
    const out = await pactl(["-f", "json", ...args]);
    return out.trim() ? JSON.parse(out) : [];
}

/** Every real input, i.e. sources that are not monitor (playback) sources. */
async function listInputSources(): Promise<PulseSource[]> {
    const sources = await pactlJson<PulseSource>(["list", "sources"]);
    return sources.filter(s => !String(s.name).endsWith(".monitor"));
}

function normalize(text: string) {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Discord reports devices by their PulseAudio *description*; map it back to a source name. */
async function resolveSourceName(description: string): Promise<string | null> {
    const sources = await listInputSources();
    const wanted = normalize(description);

    const exact = sources.find(s => normalize(s.description ?? "") === wanted);
    if (exact) return exact.name;

    const partial = sources.find(s => normalize(s.description ?? "").includes(wanted));
    if (partial) return partial.name;

    return null;
}

async function resolveSourceIndex(name: string): Promise<number | null> {
    const sources = await listInputSources();
    return sources.find(s => s.name === name)?.index ?? null;
}

function isDiscordStream(output: PulseSourceOutput) {
    const props = output.properties ?? {};
    if (String(props["application.name"] ?? "") === DISCORD_CLIENT_NAME) return true;
    // Fall back to the binary + a voice-engine-ish media name, in case Discord renames the client.
    return String(props["application.process.binary"] ?? "") === DISCORD_BINARY
        && /recStream|capture/i.test(String(props["media.name"] ?? ""));
}

/**
 * Discord recreates its capture stream on every device switch, so a one-shot reroute races
 * with it. Instead we keep enforcing: any Discord capture stream that is not on the pinned
 * source gets moved back to it.
 */
async function enforcePinnedSource() {
    if (pinnedSourceName === null || enforcing) return;
    enforcing = true;

    try {
        if (pinnedSourceIndex === null || await resolveSourceIndex(pinnedSourceName) !== pinnedSourceIndex) {
            pinnedSourceIndex = await resolveSourceIndex(pinnedSourceName);
            if (pinnedSourceIndex === null) {
                // Pinned device disappeared (unplugged / module unloaded).
                log(`pinned source ${pinnedSourceName} is gone, unpinning`);
                await clearPin();
                return;
            }
        }

        const outputs = await pactlJson<PulseSourceOutput>(["list", "source-outputs"]);
        for (const output of outputs) {
            if (!isDiscordStream(output)) continue;
            if (output.source === pinnedSourceIndex) continue;

            try {
                await pactl(["move-source-output", String(output.index), pinnedSourceName]);
                log(`moved stream #${output.index} -> ${pinnedSourceName}`);
            } catch (e) {
                log(`failed to move stream #${output.index}`, e);
            }
        }
    } catch (e) {
        log("enforce failed", e);
    } finally {
        enforcing = false;
    }
}

function startPoller() {
    if (poller !== null) return;
    poller = setInterval(() => void enforcePinnedSource(), POLL_INTERVAL_MS);
}

async function clearPin() {
    if (poller !== null) {
        clearInterval(poller);
        poller = null;
    }

    pinnedSourceName = null;
    pinnedSourceIndex = null;

    if (alsoSetSystemDefault && savedDefaultSource !== null) {
        try {
            await pactl(["set-default-source", savedDefaultSource]);
        } catch (e) {
            log("failed to restore default source", e);
        }
    }

    alsoSetSystemDefault = false;
    savedDefaultSource = null;
}

/**
 * Pin Discord's capture stream to the PipeWire source whose description matches `description`.
 * Pass null (or "default") to hand control back to Discord / the system default.
 */
export async function pinDevice(
    _: IpcMainInvokeEvent,
    description: string | null,
    setSystemDefault = false
): Promise<{ pinned?: string | null; error?: string; matchedBy?: string; }> {
    const wanted = description?.trim();

    if (!wanted || wanted.toLowerCase() === "default") {
        await clearPin();
        return { pinned: null };
    }

    const name = await resolveSourceName(wanted);
    if (name === null) {
        await clearPin();
        return { error: `No PipeWire input source matches "${wanted}"` };
    }

    const alreadyPinned = name === pinnedSourceName && setSystemDefault === alsoSetSystemDefault;
    pinnedSourceName = name;
    pinnedSourceIndex = await resolveSourceIndex(name);

    if (setSystemDefault && !alsoSetSystemDefault) {
        try {
            savedDefaultSource = (await pactl(["get-default-source"])).trim();
            await pactl(["set-default-source", name]);
            log(`system default source -> ${name} (saved "${savedDefaultSource}")`);
        } catch (e) {
            log("failed to set default source", e);
        }
    }
    alsoSetSystemDefault = setSystemDefault;

    startPoller();
    if (!alreadyPinned) await enforcePinnedSource();

    return { pinned: name };
}

export async function unpinDevice(_: IpcMainInvokeEvent) {
    await clearPin();
    return { pinned: null };
}

/** Diagnostics for the plugin settings page. */
export async function getStatus(_: IpcMainInvokeEvent) {
    const sources = await listInputSources();
    return {
        pinnedSourceName,
        pinnedSourceIndex,
        alsoSetSystemDefault,
        defaultSource: (await pactl(["get-default-source"])).trim(),
        sources: sources.map(s => ({ index: s.index, name: s.name, description: s.description }))
    };
}

/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 烤鴨 and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { MediaEngineStore, showToast, Toasts } from "@webpack/common";

const Native = VencordNative.pluginHelpers.MicSwitchFix as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
    alsoSetSystemDefault: {
        type: OptionType.BOOLEAN,
        description: "Also make the selected device the system default input (affects other apps)",
        default: false,
        restartNeeded: false
    },
    debugLogs: {
        type: OptionType.BOOLEAN,
        description: "Log stream reroutes to the console",
        default: false,
        restartNeeded: false
    }
});

let lastRequested: string | null | undefined;
let storeWatcher: ReturnType<typeof setInterval> | null = null;

function debugLog(...args: unknown[]) {
    if (settings.store.debugLogs) console.log("[MicSwitchFix]", ...args);
}

/** The device id Discord stores *is* the device name (except for the pseudo "default" entry). */
function selectedDeviceName(): string | null {
    const id: string | undefined = MediaEngineStore.getInputDeviceId?.();
    if (!id || id === "default") return null;

    const device = MediaEngineStore.getInputDevices?.()?.[id];
    return device?.name ?? id;
}

async function syncPinnedDevice() {
    const name = selectedDeviceName();
    if (name === lastRequested) return;
    lastRequested = name;

    try {
        const res = await Native.pinDevice(name, settings.store.alsoSetSystemDefault);
        if (res?.error) {
            showToast(res.error, Toasts.Type.FAILURE);
            console.error("[MicSwitchFix]", res.error);
        } else {
            debugLog(name === null ? "unpinned (using system default)" : `pinned -> ${res.pinned}`);
        }
    } catch (e) {
        console.error("[MicSwitchFix] failed to pin device", e);
    }
}

function startWatchingStore() {
    if (storeWatcher !== null) return;

    // MediaEngineStore is assigned asynchronously during app boot.
    storeWatcher = setInterval(() => {
        if (!MediaEngineStore?.addChangeListener) return;

        clearInterval(storeWatcher!);
        storeWatcher = null;

        MediaEngineStore.addChangeListener(onStoreChange);
        void syncPinnedDevice();
    }, 250);
}

function onStoreChange() {
    void syncPinnedDevice();
}

export default definePlugin({
    name: "MicSwitchFix",
    description: "Linux only: makes the input device you pick in Voice & Video actually apply to Discord's capture stream (fixes switching mic doing nothing / requiring a restart)",
    authors: [{ name: "烤鴨", id: 1058750638760149033n }],
    tags: ["Voice", "Utility"],
    settings,

    start() {
        startWatchingStore();
    },

    stop() {
        if (storeWatcher !== null) {
            clearInterval(storeWatcher);
            storeWatcher = null;
        }

        MediaEngineStore?.removeChangeListener?.(onStoreChange);
        void Native.unpinDevice();
        lastRequested = undefined;
    }
});

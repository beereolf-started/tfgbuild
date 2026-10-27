// priority: 6
"use strict";
/**
 * МОСТ К МОДУ ОКОН (tfgui, исходники в Documents/tfg-mods/tfg-ui).
 *
 * Мод рисует окна бартера и разговора, а решает всё по-прежнему KubeJS. Если мода нет на
 * сервере или у игрока, has() отвечает false - и скрипты показывают прежние окна: сундук
 * сделки и разговор в чате. Так игрок без мода не теряет ни торговлю, ни разговоры.
 *
 * Окно присылает действия строкой JSON с полем screen ("barter", "dialogue"); здесь они
 * раздаются тому, кто подписался через on(screen, fn).
 */

var UI_API = null
try { UI_API = Java.loadClass("tfg.ui.TfgUi") } catch (e) { UI_API = null }

var UI_HANDLERS = {}
var UI_TOLD = {}

function uiErr(what, e) {
    if (UI_TOLD[what]) return
    UI_TOLD[what] = true
    try { global.tfgLogError("tfg ui", what, e) } catch (err) { console.error("[tfg ui] " + what + ": " + e) }
}

function uiHas(player) {
    if (!UI_API || !player) return false
    try { return !!UI_API.hasClient(player) } catch (e) { uiErr("проверка мода у игрока", e); return false }
}

function uiSend(op, player, data) {
    if (!UI_API) return
    try { UI_API[op](player, JSON.stringify(data)) } catch (e) { uiErr("окно: " + op, e) }
}

if (UI_API) {
    try {
        UI_API.setHandler((player, json) => {
            var a = null
            try { a = JSON.parse(String(json)) } catch (e) { return }
            var fn = UI_HANDLERS[String(a.screen || "")]
            if (!fn) return
            try { fn(player, a) } catch (e) { uiErr("действие " + a.screen + "/" + a.a, e) }
        })
    } catch (e) { uiErr("подключение обработчика", e) }
}

global.TFG_UI = {
    available: () => !!UI_API,
    has: player => uiHas(player),
    open: (player, data) => uiSend("open", player, data),
    update: (player, data) => uiSend("update", player, data),
    close: player => { if (UI_API) { try { UI_API.close(player) } catch (e) { } } },
    stackNbt: stack => { try { return String(UI_API.stackNbt(stack)) } catch (e) { return "{}" } },
    on: (screen, fn) => { UI_HANDLERS[screen] = fn },
}

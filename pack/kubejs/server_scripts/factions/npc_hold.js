// priority: -10
"use strict";
/**
 * NPC СТОИТ И СМОТРИТ НА СОБЕСЕДНИКА.
 *
 * Пока у игрока открыт разговор (factions/dialogue.js) или окно сделки (factions/trade_menu.js),
 * его NPC никуда не уходит: каждый тик останавливаем навигацию и разворачиваем его лицом
 * к игроку - тело и голову, а взгляд держим на глазах игрока.
 *
 * Распорядки гостей и жителей (guests.js, settlers.js) продолжают раздавать NPC дела, но
 * этот файл грузится последним (priority -10), поэтому его тик идёт после них и последнее
 * слово остаётся за ним. Отпускаем, когда разговор кончился, игрок ушёл дальше NH_RANGE,
 * кто-то из них пропал или у NPC появилась цель для боя - драться важнее, чем болтать.
 */

const NH_RANGE = 10                 // дальше этого удержание снимается само
const NH_DEFAULT_TICKS = 3600       // если срок не назван - не дольше трёх минут

var NH_HELD = {}                    // uuid NPC -> { e, player, until, why }
var NH_TOLD = {}

function nhErr(what, e) {
    if (NH_TOLD[what]) return
    NH_TOLD[what] = true
    try { global.tfgLogError("tfg hold", what, e) } catch (err) { console.error("[tfg hold] " + what + ": " + e) }
}

function nhNow(e) { try { return Number(e.level.getTime()) } catch (err) { return 0 } }

/** Удерживать NPC возле игрока; why - кто держит ("dialogue", "trade"), чтобы снимать своё. */
function nhHold(e, player, ticks, why) {
    if (!e || !player) return
    var key = String(e.uuid)
    var old = NH_HELD[key]
    var until = nhNow(e) + (ticks || NH_DEFAULT_TICKS)
    if (old && String(old.player.uuid) === String(player.uuid) && old.until > until) until = old.until
    NH_HELD[key] = { e: e, player: player, until: until, why: why || "dialogue" }
}

/** Снять удержание этого NPC (why не указан - снять любое). */
function nhRelease(e, why) {
    if (!e) return
    var key = String(e.uuid)
    var h = NH_HELD[key]
    if (h && (!why || h.why === why)) delete NH_HELD[key]
}

/** Снять всё, что держит этот игрок (why не указан - снять любое). */
function nhReleasePlayer(player, why) {
    if (!player) return
    var pu = String(player.uuid)
    for (var key in NH_HELD) {
        var h = NH_HELD[key]
        if (String(h.player.uuid) === pu && (!why || h.why === why)) delete NH_HELD[key]
    }
}

function nhCall(obj, names, args) {
    for (var i = 0; i < names.length; i++) {
        if (typeof obj[names[i]] === "function") return obj[names[i]].apply(obj, args)
    }
    throw new Error("нет метода " + names.join("/"))
}

/** Развернуть NPC к игроку: тело, голову и взгляд. */
function nhFace(e, player) {
    var dx = player.getX() - e.getX(), dz = player.getZ() - e.getZ()
    var yaw = Math.atan2(dz, dx) * 180 / 3.141592653589793 - 90
    nhCall(e, ["setYRot", "m_146922_"], [yaw])
    nhCall(e, ["setYHeadRot", "m_5616_"], [yaw])
    nhCall(e, ["setYBodyRot", "m_5618_"], [yaw])
    e.getLookControl().setLookAt(player.getX(), player.getEyeY(), player.getZ())
}

ServerEvents.tick(event => {
    for (var key in NH_HELD) {
        var h = NH_HELD[key]
        try {
            var e = h.e, p = h.player
            if (!e.isAlive() || p.isRemoved() || nhNow(e) > h.until) { delete NH_HELD[key]; continue }
            var dx = e.getX() - p.getX(), dz = e.getZ() - p.getZ()
            if (dx * dx + dz * dz > NH_RANGE * NH_RANGE) { delete NH_HELD[key]; continue }
            var target = null
            try { target = e.getTarget() } catch (err) { }
            if (target && target.isAlive()) { delete NH_HELD[key]; continue }
            e.getNavigation().stop()
            try { nhFace(e, p) } catch (err) { nhErr("разворот к игроку", err) }   // стоять важнее, чем поворачиваться
        } catch (err) {
            nhErr("удержание " + key, err)
            delete NH_HELD[key]
        }
    }
})

global.TFG_NPC_HOLD = {
    hold: (e, player, ticks, why) => nhHold(e, player, ticks, why),
    release: (e, why) => nhRelease(e, why),
    releasePlayer: (player, why) => nhReleasePlayer(player, why),
    isHeld: e => !!(e && NH_HELD[String(e.uuid)]),
}

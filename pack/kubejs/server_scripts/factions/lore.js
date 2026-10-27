// priority: 4
"use strict";
/**
 * МОЛВА: откуда люди и что они знают.
 *
 * Факты лежат в записях мира (factions/world.js): у каждого поселения своя лента событий
 * за месяц. Здесь решается, кто о чём успел услышать.
 *
 *   Откуда гость. У каждого гостя есть родное поселение его фракции. Ближние поселения
 *   присылают людей чаще дальних: вес 1/расстояние². Караван и появляется со стороны дома.
 *
 *   Что он знает. События из поселений в пределах LR_NEAR от его дома, не свежее двух
 *   дней (весть идёт не мгновенно) и не старше месяца (дальше забывается). Чем дальше
 *   случилось, тем меньше шанс, что дошло: у самого дома - всё, на краю - каждое седьмое.
 *   Знает ли конкретный человек конкретную весть - решено раз и навсегда по его имени,
 *   поэтому, спросив дважды, услышишь то же самое.
 *
 *   Жители поселения знают то же, считая от своего поселения.
 */

const LR_DELAY = 2                   // столько дней весть идёт до людей
const LR_NEAR = 15000                // из такой округи до человека вообще доходят вести
const LR_ORIGIN_R = 30000            // откуда могут прийти гости
const LR_MIN_KNOW = 0.15             // на краю округи весть доходит хотя бы до каждого седьмого

function lrLog(t) { try { console.log("[молва] " + t) } catch (e) { } }

function lrHash(str) {
    // полиномиальный хеш по простому модулю: все числа остаются точными в double
    var h = 7
    var s = String(str)
    for (var i = 0; i < s.length; i++) h = (h * 131 + s.codePointAt(i)) % 2147483647
    for (var k = 0; k < 3; k++) h = (h * 48271) % 2147483647
    return h
}

// ─── Откуда гость ────────────────────────────────────────────────────────────

/**
 * Родное поселение гостя фракции factionId, пришедшего к точке (x, z).
 * Ближние поселения выпадают чаще: вес 1/d². Нет ни одного - гость «из дальних краёв».
 */
function lrOrigin(level, factionId, x, z) {
    var near = []
    try { near = global.TFG_WORLD.near(level, x, z, LR_ORIGIN_R, true) } catch (e) { return null }
    var cand = near.filter(n => n.site.faction === factionId && n.site.state !== "нет площадки в ячейке")
    if (!cand.length) return null
    var total = 0
    var w = cand.map(n => { var v = 1 / Math.pow(Math.max(n.dist, 2000), 2); total += v; return v })
    var roll = Math.random() * total
    for (var i = 0; i < cand.length; i++) {
        roll -= w[i]
        if (roll <= 0) return cand[i].site
    }
    return cand[cand.length - 1].site
}

// ─── Что знает человек ───────────────────────────────────────────────────────

/**
 * Вести, дошедшие до человека. who - строка, по которой решается, что именно он знает
 * (имя или uuid): так один и тот же человек всякий раз знает одно и то же.
 * ref - откуда он смотрит на мир: {x, z}.
 */
function lrKnown(level, ref, who, max) {
    var out = []
    var items = []
    try { items = global.TFG_WORLD.eventsAround(level, ref.x, ref.z, LR_NEAR, LR_DELAY) } catch (e) { return out }
    var seen = {}
    items.forEach(it => {
        // весть на всю фракцию лежит в записях нескольких поселений - слышим её один раз
        var key = lrWide(it.ev) ? it.ev.day + "|" + lrGist(it.ev) : it.ev.site + "|" + it.ev.day + "|" + it.ev.text
        if (seen[key]) return
        var chance = Math.max(LR_MIN_KNOW, 1 - it.dist / LR_NEAR)
        var roll = (lrHash(String(who) + "|" + it.ev.site + "|" + it.ev.day + "|" + it.ev.text) % 1000) / 1000
        if (roll < chance) { seen[key] = true; out.push(it) }
    })
    // сперва свежее и ближнее
    out.sort((a, b) => (b.ev.day - a.ev.day) || (a.dist - b.dist))
    return max ? out.slice(0, max) : out
}

/** Весть касается всей фракции, а не одного поселения. */
function lrWide(ev) { return ev.kind === "отношения" || !!ev.faction }

/** Суть вести без порядка сторон: «А и Б: текст» и «Б и А: текст» - одно и то же. */
function lrGist(ev) {
    var t = String(ev.text)
    var i = t.indexOf(": ")
    return i < 0 ? t : t.substring(i + 2)
}

/** Давно ли: «позавчера», «дня три назад», «на прошлой неделе», «с месяц назад». */
function lrAgo(days) {
    if (days <= 2) return "позавчера"
    if (days <= 4) return ["", "", "", "три", "четыре"][days] + " дня назад"
    if (days <= 9) return "на прошлой неделе"
    if (days <= 18) return "недели две назад"
    return "с месяц назад"
}

/** Весть в одну фразу, как её перескажет человек. */
function lrTell(item, fromSite) {
    var today = 0
    try { today = global.TFG_WORLD.day() } catch (e) { }
    var ev = item.ev
    var ago = lrAgo(today - ev.day)
    // вести на всю фракцию написаны целиком: «Эшлендеры и Марвины: не поделили брод»
    if (lrWide(ev)) return "Слышал, " + ago + " " + String(ev.text).replace(": ", " ") + "."
    var place = item.site ? "«" + item.site.name + "»" : "соседи"
    if (fromSite && item.site && item.site.id === fromSite.id) return "У нас " + ago + " " + ev.text + "."
    return "В " + place + " " + ago + " " + ev.text + "."
}

/** Запись мира, в которой живёт поселение жителей village (по номеру деревни). */
function lrSiteOfVillage(vid) {
    if (!vid) return null
    var all = {}
    try { all = global.TFG_WORLD.all() } catch (e) { return null }
    for (var id in all) if (all[id].village === vid) return all[id]
    return null
}

/**
 * Откуда человек смотрит на мир: гость - из родного поселения, житель - из своего,
 * остальные - с того места, где стоят. Возвращает { ref: {x, z}, site, who }.
 */
function lrViewOf(e) {
    var pd = e.persistentData
    var site = null
    try { if (pd.contains("tfg_origin")) site = global.TFG_WORLD.byId(String(pd.getString("tfg_origin"))) } catch (err) { }
    if (!site) {
        try {
            var it = e.getTags().iterator()
            while (it.hasNext()) {
                var t = String(it.next())
                if (t.indexOf("tfg_v_") === 0) site = lrSiteOfVillage(t.substring(6))
            }
        } catch (err) { }
    }
    var who = pd.contains("tfg_npc_id") ? String(pd.getString("tfg_npc_id")) : String(e.uuid)
    return { ref: site ? { x: site.x, z: site.z } : { x: Number(e.getX()), z: Number(e.getZ()) }, site: site, who: who }
}

/** Одна весть для разговора - или null, если ничего не слышно. */
function lrLine(level, ref, who, fromSite) {
    var known = lrKnown(level, ref, who, 6)
    if (!known.length) return null
    return lrTell(known[Math.floor(Math.random() * known.length)], fromSite)
}

// ─── Наружу ──────────────────────────────────────────────────────────────────

global.TFG_LORE = {
    origin: (level, factionId, x, z) => lrOrigin(level, factionId, x, z),
    known: (level, ref, who, max) => lrKnown(level, ref, who, max),
    tell: (item, fromSite) => lrTell(item, fromSite),
    line: (level, ref, who, fromSite) => lrLine(level, ref, who, fromSite),
    view: e => lrViewOf(e),
    // житель поселения village пересказывает весть своей округи (или null)
    villageLine: (level, village, who) => {
        var site = lrSiteOfVillage(village.id)
        return lrLine(level, site ? { x: site.x, z: site.z } : { x: village.x, z: village.z }, who || village.id, site)
    },
    delay: LR_DELAY,
    near: LR_NEAR,
}

// ─── Разбор на месте: что знают в ближайшем поселении ────────────────────────

ServerEvents.commandRegistry(event => {
    try {
        var Commands = event.commands
        event.register(Commands.literal("tfglore").requires(s => s.hasPermission(2)).executes(ctx => {
            var p = ctx.source.getPlayerOrException()
            var level = ctx.source.getServer().overworld()
            var near = []
            try { near = global.TFG_WORLD.near(level, p.getX(), p.getZ(), 30000, true) } catch (e) { }
            if (!near.length) { ctx.source.sendFailure(Text.of("Поселений поблизости нет.")); return 1 }
            var site = near[0].site
            var known = lrKnown(level, { x: site.x, z: site.z }, site.id, 8)
            var rows = ["§f" + site.name + " §7знает вестей: " + known.length +
                " (задержка " + LR_DELAY + " дн., округа " + LR_NEAR + " бл.)"]
            known.forEach(k => rows.push("§7- " + lrTell(k, site) + " §8(" + k.dist + " бл.)"))
            ctx.source.sendSuccess(Text.of(rows.join("\n")), false)
            return 1
        }))
    } catch (err) {
        console.error("[молва] ошибка регистрации команд: " + err)
    }
})

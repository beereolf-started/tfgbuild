// priority: 6
"use strict";

/**
 * ЦЕНЫ ГАРДЕРОБА: украшения, короны и одежда (медяки, как в factions/trade_goods.js: слиток меди - 10).
 *
 * Украшение tfgui:jewel/<вид>/<металл>[/<работа>/<центр>[/<бока>]] стоит как его металл с работой ювелира
 * (вдвое дороже металла) плюс камни с закрепкой (в полтора раза дороже камня). Камень - как у скупщика:
 * обычный 25, безупречный 60, изысканный 150 медяков, умноженные на ценность самоцвета.
 * Короны и тиары CosmeticArmours - по таблице. Одежда - по таблице: шубы и царское платье дороже всего.
 *
 * Кто берёт: украшения и короны - скупщик (драгоценное, factions/trade_market.js), одежду - портной.
 * Отдаёт global.TFG_WARDROBE_PRICE(id) -> { value, kind: "jewel" | "crown" | "cloth", kinds } или null.
 */

const WP_UNIT = 10
// металл украшения: цена слитка в единицах меди (как TG_METALS) и сколько его уходит на вещь
const WP_METAL = { copper: 1, brass: 2, bronze: 2, silver: 5, sterling_silver: 5, rose_gold: 8, gold: 10, platinum: 20 }
const WP_KIND_METAL = { diadem: 1.1, bracelet: 1.1, ring: 1, earrings: 1, brooch: 1, necklace: 2 }
const WP_WORK = 2                    // работа ювелира: металл в изделии вдвое дороже слитка
const WP_SETTING = 1.5               // закрепка: камень в оправе в полтора раза дороже россыпи
const WP_GRADE = { regular: 25, flawless: 60, exquisite: 150 }
// ценность самоцвета (алмаз 2 - как у скупщика, TG_GEMS)
const WP_GEM = {
    diamond: 2, ruby: 1.5, sapphire: 1.5, emerald: 1.5, chrysolite: 1.1, topaz: 1, blue_topaz: 1, opal: 1,
    amethyst: 0.8, garnet: 0.8, rutile: 0.8, monazite: 0.7, lazurite: 0.6, quartz: 0.5, apatite: 0.5,
    malachite: 0.5, cinnabar: 0.4, armalcolite: 2.5, echo: 3,
}

// короны и тиары CosmeticArmours
const WP_CROWN = {
    imperial_crown: 4000, true_diamond_crown: 5000, diamond_crown: 2500, emerald_crown: 2200, gilded_netherite_crown: 3000,
    netherite_plated_crown: 2500, sculked_crown: 1800, rose_gold_plated_crown: 1600, crown: 1500, amethyst_crown: 1500,
    amethyst_plated_crown: 1400, prismarine_plated_crown: 1200, redstone_crown: 900, slime_crown: 300,
    diamond_adorned_tiara: 1800, gilded_netherite_tiara: 1800, emerald_adorned_tiara: 1600, netherite_tiara: 1500,
    diamond_tiara: 1400, amethyst_adorned_tiara: 1100, amethyst_tiara: 900, golden_tiara: 800, rose_gold_tiara: 700,
    prismarine_tiara: 700, redstone_adorned_tiara: 700, slime_tiara: 200,
}

// шубы гардероба: шуба, штаны - половина
const WP_FUR = { caribou: 400, black_bear: 500, cougar: 550, direwolf: 600, grizzly_bear: 650, panther: 700, lion: 800,
    polar_bear: 900, tiger: 1000, sabertooth: 1200 }
// звериные шкуры tfc_textile - рубаха; штаны, шапка, сапоги - доли
const WP_HIDE = { caribou: 80, black_bear: 90, cougar: 100, direwolf: 110, grizzly_bear: 110, crocodile: 120, panther: 120,
    lion: 130, polar_bear: 140, tiger: 150, sabertooth: 170 }
const WP_SLOT = { chestplate: 1, shirt: 1, tunic: 1, sweater: 1, leggings: 0.7, pants: 0.7, boots: 0.5, shoes: 0.5,
    helmet: 0.4, hat: 0.4, cowl: 0.4 }

// одежда: [правило по id, цена рубахи/камзола]; часть тела - по WP_SLOT
const WP_CLOTH = [
    [/^cosmeticarmoursmod:emperors_attire_/, 900], [/^cosmeticarmoursmod:royal_/, 700], [/^cosmeticarmoursmod:wedding_/, 500],
    [/^cosmeticarmoursmod:(wizard|witches)_/, 300], [/^cosmeticarmoursmod:[a-z_]*knight_(armour|helmet)/, 250],
    [/^cosmeticarmoursmod:winter_/, 200], [/^cosmeticarmoursmod:ghillie_/, 150], [/^cosmeticarmoursmod:toga_/, 120],
    [/^cosmeticarmoursmod:[a-z_]*archers_attire/, 120], [/^cosmeticarmoursmod:[a-z_]*plaid_skirt/, 70],
    [/^cosmeticarmoursmod:[a-z_]*skirt/, 60], [/^cosmeticarmoursmod:(farmer|fishermans)_/, 40],
    [/^cosmeticarmoursmod:gold_laurel/, 1000], [/^cosmeticarmoursmod:regular_laurel/, 100], [/^cosmeticarmoursmod:[a-z_]*ushanka/, 200],
    [/^cosmeticarmoursmod:maid_bonnet/, 100], [/^cosmeticarmoursmod:flower_crown/, 50], [/^cosmeticarmoursmod:straw/, 40],
    [/^cosmeticarmoursmod:scarf_/, 30],
    [/^cosmeticarmoursmod:sword_sheath_netherite/, 600], [/^cosmeticarmoursmod:sword_sheath_diamond/, 500],
    [/^cosmeticarmoursmod:sword_sheath_gold/, 250], [/^cosmeticarmoursmod:sword_sheath_iron/, 60], [/^cosmeticarmoursmod:sword_sheath_stone/, 25],
    [/^cosmeticarmoursmod:sword_sheath_wood/, 20], [/^cosmeticarmoursmod:(sword_sheath_empty|empty_satchel|potion_satchel)/, 40],
    [/^villager_clothes:/, 40], [/^cozyclothing:/, 80],
    [/^tfcambiental:silk_/, 50], [/^tfcambiental:insulated_leather_/, 50], [/^tfcambiental:leather/, 60], [/^tfcambiental:wool_/, 30],
    [/^tfcambiental:straw/, 10], [/^tfcambiental:burlap_/, 10],
    [/^tfc_textile:raw_/, 12], [/^tfc_textile:(linen|cotton)_/, 20],
    [/^magistuarmory:gambeson_/, 60], [/^magistuarmory:coif/, 60], [/^magistuarmory:pantyhose/, 40],
]

function wpSlot(id) {
    var m = String(id).match(/_(chestplate|shirt|tunic|sweater|leggings|pants|boots|shoes|helmet|hat|cowl)$/)
    return m ? WP_SLOT[m[1]] : 1                                     // кольчужный капюшон, чулки - цена в таблице
}

/** Украшение по его id: металл с работой и камни с закрепкой. */
function wpJewel(id) {
    var p = String(id).substring("tfgui:jewel/".length).split("/")
    var kind = p[0], metal = p[1], grade = p[2], center = p[3], side = p[4]
    if (!WP_KIND_METAL[kind] || !WP_METAL[metal]) return 0
    var v = WP_UNIT * WP_METAL[metal] * WP_KIND_METAL[kind] * WP_WORK
    var stone = g => WP_GRADE[grade] * (WP_GEM[g] || 0.5)
    if (grade && center && WP_GRADE[grade]) v += WP_SETTING * stone(center)
    if (grade && side && WP_GRADE[grade]) v += WP_SETTING * 2 * stone(side)
    return Math.round(v)
}

var WP_CACHE = {}

/** Цена вещи гардероба и кто её берёт; null - это не гардероб. */
function wpPrice(id) {
    id = String(id)
    if (WP_CACHE[id] !== undefined) return WP_CACHE[id]
    var r = null
    var m
    if (id.indexOf("tfgui:jewel/") === 0) {
        var v = wpJewel(id)
        // украшения берут и кузнец (металл), и портной (наряд), и шахтёр (камни); скупщик - дороже всех
        if (v > 0) r = { value: v, kind: "jewel", kinds: ["blacksmith", "tailor", "miner"] }
    } else if ((m = id.match(/^cosmeticarmoursmod:([a-z_]+?)_helmet$/)) && /(crown|tiara)/.test(m[1])) {
        var key = m[1].replace(/^imperial_crown_.*/, "imperial_crown")
        if (WP_CROWN[key]) r = { value: WP_CROWN[key], kind: "crown", kinds: ["blacksmith", "tailor"] }
    } else if ((m = id.match(/^tfgui:fur_coat_(legs_)?([a-z_]+)$/)) && WP_FUR[m[2]]) {
        r = { value: Math.round(WP_FUR[m[2]] * (m[1] ? 0.5 : 1)), kind: "cloth", kinds: ["tailor"] }
    } else if ((m = id.match(/^tfc_textile:([a-z_]+)_(shirt|pants|hat|boots)$/)) && WP_HIDE[m[1]]) {
        r = { value: Math.round(WP_HIDE[m[1]] * WP_SLOT[m[2]]), kind: "cloth", kinds: ["tailor"] }
    }
    // венок из цветов - тоже «crown», но не корона: его ищем в одежде
    if (!r && id.indexOf("tfgui:jewel/") !== 0) {
        for (var i = 0; i < WP_CLOTH.length; i++) {
            if (!WP_CLOTH[i][0].test(id)) continue
            r = { value: Math.max(1, Math.round(WP_CLOTH[i][1] * wpSlot(id))), kind: "cloth", kinds: ["tailor"] }
            break
        }
    }
    WP_CACHE[id] = r
    return r
}

global.TFG_WARDROBE_PRICE = wpPrice

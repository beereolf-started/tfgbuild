// priority: 5
"use strict";

/**
 * АССОРТИМЕНТ ТОРГОВЦЕВ, ЦЕНЫ СКУПКИ И ПРАЙС СКУПЩИКА.
 *
 * Цены - в медяках (factions/coins.js). Тиры - как у рейдов (tfg/raid_tiers.js): 1 медь, 2 бронза, 3 кованое железо,
 * 4 сталь/LV, 5 чёрная сталь, 6 синяя/красная сталь, 7 алюминий/MV, 8 нержавейка/HV, 9 титан/EV, 10 вольфрам/IV.
 *
 * ЦЕНА СЧИТАЕТСЯ ПО МАТЕРИАЛУ И ФОРМЕ (tgPrice): слиток меди - TG_UNIT медяков, стержень - доля слитка, наковальня -
 * много слитков, и так далее. Поэтому одна и та же вещь стоит одинаково и в продаже, и в скупке, и новые предметы
 * подхватываются сами - список вести не нужно.
 *
 * АССОРТИМЕНТ НАКАПЛИВАЕТСЯ: на тире доступны все металлы своего тира и ниже (медный тир - медь; бронзовый - медь и
 * бронза, и так далее). Поэтому предложений много - окно сделки листается страницами (factions/trade_menu.js).
 *
 * СКУПКА (игрок продаёт торговцу): у каждого вида свои правила - по id предмета (tgKindBuys). Что торговец продаёт,
 * то и покупает, плюс родственные вещи: кузнец берёт любой металлический прокат, шахтёр - руду, порошки и камень,
 * повар - еду, и так далее. Цена - доля от реальной (коэффициент отношений считает factions/trade_menu.js).
 *
 * Id, которых на сервере нет, отбрасываются при выдаче (trValidItem в factions/trader.js).
 *
 * Отдаёт global.TFG_TRADE_GOODS: kinds, kind(id), kindsFor(tier), offers(kind, tier), sellPrice(kind, stack), buyPrice(stack).
 */

const TG_UNIT = 10                  // медяков за слиток меди - от него пляшут все цены

// металл: тир, цена слитка в единицах меди
const TG_METALS = [
    { id: "copper", tier: 1, value: 1, tfc: true },
    { id: "tin", tier: 1, value: 1.2 }, { id: "zinc", tier: 1, value: 1.2 }, { id: "bismuth", tier: 1, value: 1.4 },
    { id: "lead", tier: 1, value: 1.3 }, { id: "silver", tier: 1, value: 5 }, { id: "gold", tier: 1, value: 10 },
    { id: "bronze", tier: 2, value: 2, tfc: true }, { id: "bismuth_bronze", tier: 2, value: 2.2, tfc: true },
    { id: "black_bronze", tier: 2, value: 2.4, tfc: true }, { id: "brass", tier: 2, value: 2 },
    { id: "sterling_silver", tier: 2, value: 5 }, { id: "rose_gold", tier: 2, value: 8 }, { id: "electrum", tier: 2, value: 8 },
    { id: "wrought_iron", tier: 3, value: 4, tfc: true }, { id: "cast_iron", tier: 3, value: 3 },
    { id: "nickel", tier: 3, value: 4 }, { id: "invar", tier: 3, value: 5 },
    { id: "steel", tier: 4, value: 8, tfc: true }, { id: "magnesium", tier: 4, value: 4 }, { id: "manganese", tier: 4, value: 4 },
    { id: "black_steel", tier: 5, value: 16, tfc: true }, { id: "chromium", tier: 5, value: 12 },
    { id: "blue_steel", tier: 6, value: 32, tfc: true }, { id: "red_steel", tier: 6, value: 32, tfc: true },
    { id: "aluminium", tier: 7, value: 16 }, { id: "platinum", tier: 7, value: 20 },
    { id: "stainless_steel", tier: 8, value: 24 }, { id: "titanium", tier: 9, value: 48 },
    { id: "tungsten", tier: 10, value: 60 }, { id: "tungsten_steel", tier: 10, value: 96 },
]
const TG_METAL_BY_ID = {}
TG_METALS.forEach(m => { TG_METAL_BY_ID[m.id] = m })

// форма проката GregTech: доля слитка и сколько штук в партии
const TG_FORMS = {
    nugget: [0.12, 16], ingot: [1, 4], dust: [0.9, 4], small_dust: [0.25, 8], tiny_dust: [0.12, 16],
    plate: [1.1, 4], double_plate: [2.3, 2], curved_plate: [1.2, 4], rod: [0.55, 8], long_rod: [1.1, 4],
    bolt: [0.16, 16], screw: [0.18, 16], ring: [0.3, 8], foil: [0.32, 8], gear: [4.2, 2], small_gear: [1.1, 4],
    rotor: [4.6, 2], spring: [1.2, 4], small_spring: [0.3, 8], round: [0.14, 16], wire_fine: [0.08, 16],
    frame: [2.6, 2], block: [9, 1],
}
// инструменты GregTech: цена в слитках материала
const TG_GT_TOOLS = { sword: 3, axe: 2.6, pickaxe: 2.6, shovel: 1.4, hoe: 1.6, knife: 1.2, butchery_knife: 2.4, saw: 2.4,
    hammer: 3, file: 1.6, screwdriver: 1.2, wrench: 3.4, wire_cutter: 2.4, mortar: 1.2, scythe: 3.2, spear: 2.2,
    mining_hammer: 6, plunger: 2, crowbar: 2.4 }
// вещи TFC из металла: цена в слитках и штук в партии
const TG_TFC_METAL = { anvil: [25, 1], tuyere: [4, 1], bars: [1.2, 8], chain: [1, 16], lamp: [2.5, 1], trapdoor: [2, 1],
    chisel: [1.5, 1], propick: [2, 1], fishing_rod: [2.5, 1], mace: [3, 1], javelin: [2, 3], shield: [4, 1],
    helmet: [4, 1], chestplate: [7, 1], greaves: [6, 1], boots: [3.5, 1], unfinished_helmet: [2.4, 1],
    unfinished_chestplate: [4.2, 1], unfinished_greaves: [3.6, 1], unfinished_boots: [2.1, 1] }

const TG_ROCKS = ["granite", "diorite", "gabbro", "shale", "claystone", "limestone", "conglomerate", "dolomite", "chert", "chalk",
    "rhyolite", "basalt", "andesite", "dacite", "quartzite", "slate", "phyllite", "schist", "gneiss", "marble"]
const TG_WOODS = ["acacia", "ash", "aspen", "birch", "blackwood", "chestnut", "douglas_fir", "hickory", "kapok", "mangrove",
    "maple", "oak", "palm", "pine", "rosewood", "sequoia", "spruce", "sycamore", "white_cedar", "willow"]
const TG_CROPS = ["wheat", "barley", "oat", "rye", "maize", "rice", "potato", "carrot", "onion", "cabbage", "garlic", "tomato",
    "beet", "soybean", "squash", "sugarcane", "jute", "papyrus", "green_bean", "yellow_bell_pepper", "red_bell_pepper", "pumpkin", "melon"]
const TG_VEGETABLES = ["wheat", "barley", "oat", "rye", "maize", "rice", "potato", "carrot", "onion", "cabbage", "garlic", "tomato",
    "beet", "soybean", "squash", "green_bean", "yellow_bell_pepper", "red_bell_pepper", "sugarcane"]
const TG_FRUITS = ["cherry", "green_apple", "red_apple", "lemon", "olive", "orange", "peach", "plum", "banana",
    "blackberry", "blueberry", "strawberry", "raspberry", "cranberry"]
const TG_FISH = ["cod", "salmon", "tropical_fish", "bluegill", "lake_trout", "rainbow_trout", "largemouth_bass", "smallmouth_bass", "crappie"]
const TG_MEAT = ["beef", "pork", "mutton", "chicken", "venison", "horse_meat", "rabbit", "bear", "duck", "calamari", "turkey", "grouse", "pheasant", "quail"]
const TG_GRAINS = ["wheat", "barley", "oat", "rye", "maize", "rice"]
// руда: минерал и цена "обычного" куска в слитках меди; сорт меняет цену
const TG_MINERALS = { native_copper: [1, 1], malachite: [1, 1], tetrahedrite: [1, 1], cassiterite: [1.5, 1], bismuthinite: [1.4, 1],
    sphalerite: [1.2, 1], native_silver: [5, 1], native_gold: [10, 1], hematite: [1.5, 2], magnetite: [1.5, 2], limonite: [1.5, 2],
    garnierite: [4, 3], galena: [1.6, 1], cinnabar: [3, 3], cryolite: [4, 4], saltpeter: [1, 1], sulfur: [1.2, 1], sylvite: [1.2, 1],
    borax: [2, 3], graphite: [2.5, 2], kaolinite: [1, 1], gypsum: [1, 1], halite: [1, 1], lapis_lazuli: [3, 2], bituminous_coal: [1, 1], lignite: [0.7, 1] }
const TG_ORE_GRADE = { small: 0.35, poor: 0.6, normal: 1, rich: 1.5 }
// порошки и прочая мелочь: цена штуки в единицах меди
const TG_POWDERS = { salt: 0.08, charcoal: 0.06, coke: 0.12, flux: 0.1, graphite: 0.25, saltpeter: 0.12, sulfur: 0.2,
    lapis_lazuli: 0.4, hematite: 0.15, limonite: 0.15, malachite: 0.15, native_copper: 0.15, native_gold: 0.8, native_silver: 0.5,
    kaolinite: 0.1, sylvite: 0.12, wood_ash: 0.04 }

function tgRand(list) { return list[Math.floor(Math.random() * list.length)] }
function tgRound(n) { return Math.max(1, Math.round(n)) }

// ─── Цена по материалу и форме ───────────────────────────────────────────────

/** Реальная цена ОДНОЙ штуки в медяках или 0, если такой вещи в прайсе нет. */
function tgPrice(id) {
    var m
    // украшения, короны, одежда - factions/wardrobe_prices.js
    var w = null
    try { w = global.TFG_WARDROBE_PRICE(String(id)) } catch (e) { }
    if (w) return w.value
    // GregTech: <металл>_<форма> и инструменты
    m = id.match(/^gtceu:([a-z_]+)_(nugget|ingot|dust|small_dust|tiny_dust|plate|double_plate|curved_plate|rod|long_rod|bolt|screw|ring|foil|gear|small_gear|rotor|spring|small_spring|round|wire_fine|frame|block)$/)
    if (m && TG_METAL_BY_ID[m[1]] && TG_FORMS[m[2]]) return TG_UNIT * TG_METAL_BY_ID[m[1]].value * TG_FORMS[m[2]][0]
    m = id.match(/^gtceu:([a-z_]+)_([a-z_]+)$/)
    if (m && TG_METAL_BY_ID[m[1]] && TG_GT_TOOLS[m[2]]) return TG_UNIT * TG_METAL_BY_ID[m[1]].value * TG_GT_TOOLS[m[2]]
    // TFC: metal/<вещь>/<металл>
    m = id.match(/^tfc:metal\/([a-z_]+)\/([a-z_]+)$/)
    if (m && TG_TFC_METAL[m[1]] && TG_METAL_BY_ID[m[2]]) return TG_UNIT * TG_METAL_BY_ID[m[2]].value * TG_TFC_METAL[m[1]][0]
    // руда и порошки
    m = id.match(/^tfc:ore\/(small|poor|normal|rich)_([a-z_]+)$/)
    if (m && TG_MINERALS[m[2]]) return TG_UNIT * TG_MINERALS[m[2]][0] * TG_ORE_GRADE[m[1]] * 0.5
    m = id.match(/^tfc:ore\/([a-z_]+)$/)
    if (m && TG_MINERALS[m[1]]) return TG_UNIT * TG_MINERALS[m[1]][0] * 0.4
    m = id.match(/^tfc:powder\/([a-z_]+)$/)
    if (m) return TG_UNIT * (TG_POWDERS[m[1]] || 0.15)
    return 0
}

function tgItem(item, count, price, stock) {
    return { item: item, count: count, price: tgRound(price), stock: stock }
}

/** Партия проката/инструмента по цене материала. */
function tgMetalItem(id, count, unitPrice, stock) {
    return tgItem(id, count, unitPrice * count * 1.15, stock)      // наценка торговца
}

/** Металлы, доступные на тире: свой тир и все, что ниже (ассортимент накапливается). */
function tgMetalsUpTo(tier, onlyTfc) {
    return TG_METALS.filter(m => m.tier <= tier && (!onlyTfc || m.tfc))
}

// ─── Виды торговцев ──────────────────────────────────────────────────────────
//
// goods(tier) - что продаёт; buys - по каким id скупает (правило: строка-подстрока, регулярка или функция).
// Цена скупки берётся из tgPrice, а если её там нет - из собственного прайса вида (tgKindPrice).

function tgBlacksmith(tier) {
    var out = []
    tgMetalsUpTo(tier).forEach(m => {
        var forms = ["ingot", "plate", "rod", "bolt", "screw", "ring", "foil", "nugget", "gear", "dust"]
        forms.forEach(f => {
            var fv = TG_FORMS[f]
            out.push(tgMetalItem("gtceu:" + m.id + "_" + f, fv[1], TG_UNIT * m.value * fv[0], 3))
        })
        ;["hammer", "file", "wrench", "screwdriver"].forEach(tool => {
            out.push(tgMetalItem("gtceu:" + m.id + "_" + tool, 1, TG_UNIT * m.value * TG_GT_TOOLS[tool], 1))
        })
    })
    tgMetalsUpTo(tier, true).forEach(m => {
        ;["anvil", "tuyere", "bars", "chain", "lamp", "trapdoor", "chisel"].forEach(thing => {
            var tv = TG_TFC_METAL[thing]
            out.push(tgMetalItem("tfc:metal/" + thing + "/" + m.id, tv[1], TG_UNIT * m.value * tv[0], 2))
        })
    })
    out.push(tgItem("tfc:powder/flux", 16, TG_UNIT * 0.1 * 16 * 1.15, 4))
    out.push(tgItem("tfc:bellows", 1, 40, 1))
    out.push(tgItem("tfc:crucible", 1, 120, 1))
    return out
}

function tgWeaponsmith(tier) {
    var out = [tgItem("minecraft:bow", 1, 40, 2), tgItem("minecraft:arrow", 16, 8, 6), tgItem("minecraft:crossbow", 1, 80, 1)]
    tgMetalsUpTo(tier).forEach(m => {
        ;["sword", "axe", "spear", "knife"].forEach(tool => {
            out.push(tgMetalItem("gtceu:" + m.id + "_" + tool, 1, TG_UNIT * m.value * TG_GT_TOOLS[tool], 1))
        })
    })
    tgMetalsUpTo(tier, true).forEach(m => {
        ;["mace", "javelin", "shield"].forEach(thing => {
            var tv = TG_TFC_METAL[thing]
            out.push(tgMetalItem("tfc:metal/" + thing + "/" + m.id, tv[1], TG_UNIT * m.value * tv[0], 2))
        })
    })
    return out
}

// ─── Ружейник: стволы TACZ и патроны к ним ───────────────────────────────────
//
// Стволы берём из таблицы сборки (factions/guns_data.js), ставим только те, что загружены
// ганпаком (factions/gun_items.js). С какого тира ствол в продаже - по ганпаку: кремнёвка
// раньше всех, простые стволы TACZ (пистолеты, дробовики, рычажные) с кованого железа,
// стволы Create Armorer - с механики, тяжёлое - со стали и чёрной стали, AE2 - с MV.
// Холодное оружие ганпаков (патрон "melee") не продаём: это не стрельба.

const TG_GUN_MAX = 12                   // стволов в одной лавке; к каждому - его патрон

function tgGunTier(id, simple) {
    var ns = id.split(":")[0]
    if (ns === "ulv_guns") return 2
    if (ns === "applied_armorer") return 7
    if (ns === "create_armorer") return simple ? 4 : 5
    return simple ? 3 : 5
}

/** Цена ствола в медяках (без наценки): от тира, тяжёлое дороже простого. */
function tgGunPrice(id) {
    var g = null
    try { g = global.TFG_GUNS[id] } catch (e) { }
    if (!g) return 0
    var tier = tgGunTier(id, g[1])
    var base = { 2: 15, 3: 30, 4: 45, 5: 75, 7: 180 }[tier] || 75
    return TG_UNIT * base * (g[1] ? 1 : 1.3)
}

/** Цена одного патрона: дорожает с тиром самого дешёвого ствола под этот калибр. */
function tgAmmoPrice(ammo) {
    var tier = 0
    try {
        for (var id in global.TFG_GUNS) {
            var g = global.TFG_GUNS[id]
            if (g[0] !== ammo) continue
            var t = tgGunTier(id, g[1])
            if (!tier || t < tier) tier = t
        }
    } catch (e) { }
    if (!tier) return 0
    return { 2: 1, 3: 2, 4: 3, 5: 4, 7: 8 }[tier] || 4
}

function tgGunsmith(tier) {
    var guns = []
    try {
        for (var id in global.TFG_GUNS) {
            var g = global.TFG_GUNS[id]
            if (!g || String(g[0]).indexOf("melee") >= 0) continue
            if (tgGunTier(id, g[1]) > tier) continue
            if (!global.TFG_GUN_ITEMS.loaded(id)) continue
            guns.push(id)
        }
    } catch (e) { }
    // каждая лавка со своим набором стволов; цены от набора не зависят
    for (var i = guns.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1))
        var t = guns[i]; guns[i] = guns[j]; guns[j] = t
    }
    var out = []
    var ammoDone = {}
    guns.slice(0, TG_GUN_MAX).forEach(id => {
        out.push({ item: global.TFG_GUN_ITEMS.GUN_ITEM, gun: id, count: 1, price: tgRound(tgGunPrice(id) * 1.15), stock: 1 })
        var ammo = global.TFG_GUNS[id][0]
        if (ammoDone[ammo]) return
        ammoDone[ammo] = true
        var n = ammo.indexOf("12g") >= 0 || ammo.indexOf("shot") >= 0 ? 16 : 30
        out.push({ item: global.TFG_GUN_ITEMS.AMMO_ITEM, ammo: ammo, count: n, price: tgRound(tgAmmoPrice(ammo) * n * 1.15), stock: 4 })
    })
    return out
}

function tgArmorer(tier) {
    var out = [
        tgItem("tfcambiental:insulated_leather_hat", 1, 30, 1), tgItem("tfcambiental:insulated_leather_tunic", 1, 50, 1),
        tgItem("tfcambiental:insulated_leather_pants", 1, 45, 1), tgItem("tfcambiental:insulated_leather_boots", 1, 25, 1),
    ]
    tgMetalsUpTo(tier, true).forEach(m => {
        ;["helmet", "chestplate", "greaves", "boots", "shield", "unfinished_helmet", "unfinished_chestplate"].forEach(thing => {
            var tv = TG_TFC_METAL[thing]
            out.push(tgMetalItem("tfc:metal/" + thing + "/" + m.id, tv[1], TG_UNIT * m.value * tv[0], 1))
        })
    })
    return out
}

function tgMiner(tier) {
    var out = [
        tgItem("tfc:torch", 16, 6, 5), tgItem("tfc:powder/flux", 16, 18, 4), tgItem("tfc:powder/graphite", 8, 22, 2),
        tgItem("tfc:powder/sulfur", 8, 18, 3), tgItem("tfc:powder/saltpeter", 8, 12, 3), tgItem("tfc:powder/charcoal", 16, 12, 4),
        tgItem("tfc:ore/bituminous_coal", 16, 14, 3), tgItem("tfc:ore/lignite", 16, 10, 3),
    ]
    for (var k in TG_MINERALS) {
        var min = TG_MINERALS[k]
        if (min[1] > tier) continue
        ;["small", "normal"].forEach(g => {
            var price = tgPrice("tfc:ore/" + g + "_" + k)
            if (price > 0) out.push(tgItem("tfc:ore/" + g + "_" + k, g === "small" ? 16 : 8, price * (g === "small" ? 16 : 8) * 1.15, 2))
        })
    }
    tgMetalsUpTo(tier).forEach(m => {
        ;["pickaxe", "shovel", "hammer", "mining_hammer"].forEach(tool => {
            out.push(tgMetalItem("gtceu:" + m.id + "_" + tool, 1, TG_UNIT * m.value * TG_GT_TOOLS[tool], 1))
        })
    })
    tgMetalsUpTo(tier, true).forEach(m => {
        out.push(tgMetalItem("tfc:metal/propick/" + m.id, 1, TG_UNIT * m.value * TG_TFC_METAL.propick[0], 1))
    })
    TG_ROCKS.forEach(r => out.push(tgItem("tfc:rock/loose/" + r, 16, 4, 2)))
    return out
}

// Лесоруб и камнелом - одиночки (приходят без охраны, guests.js GS_SOLO_KINDS): товар простой,
// своими руками добытый, зато дешевле, чем у плотника и строителя.
function tgLumberjack(tier) {
    var out = [tgItem("tfc:stick_bundle", 8, 4, 4), tgItem("minecraft:stick", 32, 3, 4)]
    TG_WOODS.forEach(w => {
        out.push(tgItem("tfc:wood/log/" + w, 16, 6, 3))
        out.push(tgItem("tfc:wood/lumber/" + w, 16, 5, 2))
        out.push(tgItem("tfc:wood/sapling/" + w, 4, 4, 2))
    })
    return out
}

function tgQuarryman(tier) {
    var out = [tgItem("tfc:powder/flux", 16, 14, 3)]
    TG_ROCKS.forEach(r => {
        out.push(tgItem("tfc:rock/raw/" + r, 16, 5, 2))
        out.push(tgItem("tfc:rock/cobble/" + r, 16, 4, 3))
        out.push(tgItem("tfc:rock/loose/" + r, 16, 3, 3))
        out.push(tgItem("tfc:rock/gravel/" + r, 16, 3, 2))
        out.push(tgItem("tfc:brick/" + r, 16, 6, 2))
    })
    return out
}

function tgCarpenter(tier) {
    var out = [tgItem("tfc:wooden_bucket", 1, 10, 2), tgItem("tfc:straw", 16, 4, 4), tgItem("tfc:thatch", 16, 5, 4)]
    TG_WOODS.forEach(w => {
        out.push(tgItem("tfc:wood/log/" + w, 16, 9, 3))
        out.push(tgItem("tfc:wood/planks/" + w, 16, 7, 4))
        out.push(tgItem("tfc:wood/lumber/" + w, 16, 7, 4))
        out.push(tgItem("tfc:wood/support/" + w, 8, 9, 3))
        out.push(tgItem("tfc:wood/chest/" + w, 1, 16, 2))
        out.push(tgItem("tfc:wood/barrel/" + w, 1, 22, 2))
        out.push(tgItem("tfc:wood/planks/" + w + "_workbench", 1, 12, 1))
        out.push(tgItem("tfc:wood/planks/" + w + "_door", 1, 9, 1))
        out.push(tgItem("tfc:wood/planks/" + w + "_fence", 8, 9, 2))
        out.push(tgItem("tfc:wood/sluice/" + w, 1, 22, 1))
        out.push(tgItem("tfc:wood/scribing_table/" + w, 1, 26, 1))
    })
    tgMetalsUpTo(tier).forEach(m => {
        ;["saw", "axe"].forEach(tool => out.push(tgMetalItem("gtceu:" + m.id + "_" + tool, 1, TG_UNIT * m.value * TG_GT_TOOLS[tool], 1)))
    })
    return out
}

function tgBuilder(tier) {
    var out = [tgItem("tfc:mortar", 16, 7, 6), tgItem("tfc:fire_clay", 8, 11, 4), tgItem("tfc:kaolin_clay", 8, 9, 4),
        tgItem("tfc:ceramic/fire_brick", 16, 22, 3), tgItem("tfc:fire_bricks", 8, 55, 2)]
    TG_ROCKS.forEach(r => {
        out.push(tgItem("tfc:brick/" + r, 32, 9, 4))
        out.push(tgItem("tfc:rock/cobble/" + r, 32, 7, 3))
        out.push(tgItem("tfc:rock/bricks/" + r, 16, 12, 3))
        out.push(tgItem("tfc:rock/smooth/" + r, 16, 12, 2))
    })
    tgMetalsUpTo(tier).forEach(m => {
        ;["hammer", "saw"].forEach(tool => out.push(tgMetalItem("gtceu:" + m.id + "_" + tool, 1, TG_UNIT * m.value * TG_GT_TOOLS[tool], 1)))
    })
    tgMetalsUpTo(tier, true).forEach(m => out.push(tgMetalItem("tfc:metal/chisel/" + m.id, 1, TG_UNIT * m.value * 1.5, 1)))
    return out
}

function tgPotter(tier) {
    var out = [
        tgItem("tfc:ceramic/jug", 1, 8, 3), tgItem("tfc:ceramic/vessel", 1, 12, 3), tgItem("tfc:ceramic/large_vessel", 1, 30, 2),
        tgItem("tfc:ceramic/bowl", 4, 8, 3), tgItem("tfc:ceramic/pot", 1, 12, 2), tgItem("tfc:ceramic/ingot_mold", 2, 10, 3),
        tgItem("tfc:ceramic/fire_ingot_mold", 2, 30, 2), tgItem("tfc:ceramic/axe_head_mold", 1, 12, 1),
        tgItem("tfc:ceramic/unfired_jug", 2, 4, 2), tgItem("tfc:ceramic/unfired_brick", 16, 6, 4),
        tgItem("tfc:ceramic/unfired_vessel", 2, 6, 3), tgItem("tfc:fire_clay", 8, 11, 3), tgItem("tfc:kaolin_clay", 8, 9, 3),
        tgItem("minecraft:clay_ball", 16, 7, 4), tgItem("tfc:crucible", 1, 120, 1),
    ]
    return out
}

function tgFoodKind(tier, which) {
    var out = []
    var add = (id, count, price, stock) => out.push(tgItem(id, count, price, stock))
    if (which === "butcher") {
        TG_MEAT.forEach(f => add("tfc:food/" + f, 4, 7, 4))
        TG_MEAT.forEach(f => add("tfc:food/cooked_" + f, 4, 11, 3))
        add("tfc:powder/salt", 8, 7, 5)
        tgMetalsUpTo(tier).forEach(m => {
            ;["knife", "butchery_knife"].forEach(tool => out.push(tgMetalItem("gtceu:" + m.id + "_" + tool, 1, TG_UNIT * m.value * TG_GT_TOOLS[tool], 1)))
        })
    } else if (which === "cook") {
        TG_GRAINS.forEach(g => { add("tfc:food/" + g + "_bread", 4, 9, 3); add("tfc:food/" + g + "_dough", 4, 6, 2); add("tfc:food/" + g + "_flour", 4, 6, 3) })
        ;["cooked_beef", "cooked_pork", "cooked_chicken", "cooked_mutton", "cooked_cod", "cooked_salmon", "boiled_egg"].forEach(f => add("tfc:food/" + f, 4, 10, 3))
        add("tfc:food/cheese", 2, 15, 2)
        add("firmalife:food/cheddar", 2, 20, 2)
        add("firmalife:food/butter", 2, 12, 2)
        add("tfc:powder/salt", 8, 7, 4)
        add("tfc:food/sugarcane", 8, 8, 2)
    } else if (which === "fisherman") {
        TG_FISH.forEach(f => add("tfc:food/" + f, 4, 7, 3))
        add("tfc:food/cooked_cod", 4, 10, 3)
        add("tfc:food/cooked_salmon", 4, 10, 3)
        add("tfc:food/shellfish", 4, 6, 3)
        add("tfc:food/fresh_seaweed", 8, 5, 3)
        add("tfc:food/dried_seaweed", 8, 7, 3)
        add("tfc:powder/salt", 8, 7, 4)
        tgMetalsUpTo(tier, true).forEach(m => out.push(tgMetalItem("tfc:metal/fishing_rod/" + m.id, 1, TG_UNIT * m.value * 2.5, 1)))
    }
    return out
}

function tgHunter(tier) {
    var out = [
        tgItem("tfc:small_raw_hide", 2, 9, 4), tgItem("tfc:medium_raw_hide", 2, 17, 3), tgItem("tfc:large_raw_hide", 1, 13, 3),
        tgItem("tfc:small_sheepskin_hide", 1, 9, 2), tgItem("tfc:medium_sheepskin_hide", 1, 15, 2), tgItem("tfc:large_sheepskin_hide", 1, 21, 2),
        tgItem("minecraft:feather", 8, 5, 5), tgItem("minecraft:bone", 8, 4, 5),
        tgItem("minecraft:bow", 1, 40, 2), tgItem("minecraft:arrow", 16, 9, 5),
    ]
    tgMetalsUpTo(tier, true).forEach(m => out.push(tgMetalItem("tfc:metal/javelin/" + m.id, 3, TG_UNIT * m.value * 2, 2)))
    TG_MEAT.forEach(f => out.push(tgItem("tfc:food/" + f, 4, 7, 2)))
    return out
}

function tgGardener(tier) {
    var out = [tgItem("tfc:powder/saltpeter", 8, 12, 3), tgItem("tfc:straw", 16, 5, 3),
        tgItem("gtceu:fertilizer", 8, 16, 2), tgItem("tfc:composter", 1, 25, 1)]
    TG_CROPS.forEach(c => out.push(tgItem("tfc:seeds/" + c, 8, 6, 4)))
    TG_WOODS.forEach(w => out.push(tgItem("tfc:wood/sapling/" + w, 2, 7, 3)))
    TG_VEGETABLES.forEach(c => out.push(tgItem("tfc:food/" + c, 8, 8, 3)))
    TG_FRUITS.forEach(f => out.push(tgItem("tfc:food/" + f, 8, 10, 2)))
    tgMetalsUpTo(tier).forEach(m => {
        ;["hoe", "scythe"].forEach(tool => out.push(tgMetalItem("gtceu:" + m.id + "_" + tool, 1, TG_UNIT * m.value * TG_GT_TOOLS[tool], 1)))
    })
    return out
}

function tgTailor(tier) {
    return [
        tgItem("tfc:burlap_cloth", 8, 7, 5), tgItem("tfc:wool_cloth", 8, 13, 4), tgItem("tfc:silk_cloth", 4, 22, 3),
        tgItem("tfc:wool_yarn", 16, 9, 4), tgItem("tfc:wool", 8, 8, 4), tgItem("tfc:jute_fiber", 16, 5, 4),
        tgItem("tfc:jute", 8, 5, 3), tgItem("tfc:spindle", 1, 6, 2), tgItem("tfc:bone_needle", 1, 5, 2),
        tgItem("tfc:small_prepared_hide", 1, 10, 3), tgItem("tfc:medium_prepared_hide", 1, 16, 3), tgItem("tfc:large_prepared_hide", 1, 22, 2),
        tgItem("tfc:small_soaked_hide", 1, 7, 2), tgItem("tfc:medium_soaked_hide", 1, 12, 2),
        tgItem("tfc_textile:linen_shirt", 1, 20, 2), tgItem("tfc_textile:cotton_pants", 1, 20, 2),
        tgItem("tfcambiental:wool_sweater", 1, 30, 2), tgItem("tfcambiental:silk_shirt", 1, 50, 1),
    ]
}

const TG_CREATE_BASE = { shaft: [8, 8], cogwheel: [4, 10], large_cogwheel: [2, 12], belt_connector: [4, 12], gearbox: [1, 15],
    hand_crank: [1, 10], water_wheel: [1, 30], large_water_wheel: [1, 60], millstone: [1, 40], wrench: [1, 20], clutch: [1, 20],
    gearshift: [1, 20], encased_chain_drive: [2, 20], chute: [4, 16], depot: [1, 15], andesite_casing: [4, 16],
    mechanical_press: [1, 60], encased_fan: [1, 50], mechanical_bearing: [1, 40], mechanical_saw: [1, 55], mechanical_drill: [1, 55],
    mechanical_harvester: [1, 45], deployer: [1, 70], mechanical_arm: [1, 90], belt_observer: [1, 25], andesite_funnel: [4, 14] }
const TG_CREATE_BRASS = { brass_casing: [4, 40], precision_mechanism: [1, 60], mechanical_mixer: [1, 80], mechanical_crafter: [1, 90],
    brass_funnel: [4, 30], smart_chute: [1, 45], weighted_ejector: [1, 45], rotation_speed_controller: [1, 90], speedometer: [1, 30],
    stressometer: [1, 30], fluid_pipe: [8, 20], mechanical_pump: [1, 45], fluid_tank: [2, 40], portable_storage_interface: [1, 60] }

function tgMechanic(tier) {
    var out = []
    for (var k in TG_CREATE_BASE) out.push(tgItem("create:" + k, TG_CREATE_BASE[k][0], TG_CREATE_BASE[k][1], 2))
    if (tier >= 4) for (var b in TG_CREATE_BRASS) out.push(tgItem("create:" + b, TG_CREATE_BRASS[b][0], TG_CREATE_BRASS[b][1], 2))
    return out
}

// напряжение: тир игрока, множитель цены, материал провода
const TG_VOLTAGE = [{ id: "lv", tier: 4, factor: 1, cable: "tin" }, { id: "mv", tier: 7, factor: 4, cable: "copper" },
    { id: "hv", tier: 8, factor: 16, cable: "gold" }, { id: "ev", tier: 9, factor: 64, cable: "aluminium" },
    { id: "iv", tier: 10, factor: 256, cable: "platinum" }]
const TG_GT_PARTS = { machine_hull: 200, electric_motor: 150, electric_pump: 250, conveyor_module: 250, robot_arm: 400,
    electric_piston: 300, emitter: 450, sensor: 450, field_generator: 600, voltage_coil: 60, battery_hull: 60,
    energy_input_hatch: 500, energy_output_hatch: 500, item_import_bus: 120, item_export_bus: 120, fluid_import_hatch: 150, fluid_export_hatch: 150 }

function tgElectrician(tier) {
    var out = [
        tgItem("gtceu:vacuum_tube", 4, 60, 3), tgItem("gtceu:resistor", 8, 60, 3), tgItem("gtceu:diode", 8, 70, 3),
        tgItem("gtceu:capacitor", 8, 70, 3), tgItem("gtceu:transistor", 8, 80, 3), tgItem("gtceu:basic_electronic_circuit", 1, 120, 3),
        tgItem("gtceu:lv_sodium_battery", 1, 150, 2), tgItem("gtceu:lv_battery_hull", 1, 60, 2),
    ]
    if (tier >= 7) {
        out.push(tgItem("gtceu:good_electronic_circuit", 1, 400, 2))
        out.push(tgItem("gtceu:mv_sodium_battery", 1, 500, 1))
    }
    TG_VOLTAGE.forEach(v => {
        if (v.tier > tier) return
        for (var part in TG_GT_PARTS) out.push(tgItem("gtceu:" + v.id + "_" + part, 1, TG_GT_PARTS[part] * v.factor, 1))
        out.push(tgItem("gtceu:" + v.cable + "_single_cable", 8, 40 * v.factor, 3))
        out.push(tgItem("gtceu:" + v.cable + "_quadruple_cable", 4, 80 * v.factor, 2))
        out.push(tgItem("gtceu:" + v.id + "_transformer_1a", 1, 400 * v.factor, 1))
        out.push(tgItem("gtceu:" + v.id + "_machine_casing", 4, 150 * v.factor, 2))
    })
    tgMetalsUpTo(tier).forEach(m => {
        ;["wrench", "screwdriver", "wire_cutter", "file"].forEach(tool => out.push(tgMetalItem("gtceu:" + m.id + "_" + tool, 1, TG_UNIT * m.value * TG_GT_TOOLS[tool], 1)))
    })
    return out
}

// правила скупки: строка - начало id, регулярка - совпадение, функция - своя проверка
const TG_KINDS = [
    { id: "weaponsmith", name: "Оружейник", minTier: 1, goods: tgWeaponsmith,
        buys: [/^gtceu:[a-z_]+_(sword|axe|spear|knife)$/, /^tfc:metal\/(mace|javelin|shield)\//, "minecraft:bow", "minecraft:crossbow", "minecraft:arrow"] },
    { id: "gunsmith", name: "Ружейник", minTier: 3, goods: tgGunsmith,
        buys: ["tacz:modern_kinetic_gun", "tacz:ammo"] },
    { id: "armorer", name: "Бронник", minTier: 1, goods: tgArmorer,
        buys: [/^tfc:metal\/(helmet|chestplate|greaves|boots|shield|unfinished_)/, /^tfcambiental:insulated_leather/, /^tfc:(small|medium|large)_prepared_hide$/] },
    { id: "blacksmith", name: "Кузнец", minTier: 1, goods: tgBlacksmith,
        buys: [/^gtceu:[a-z_]+_(nugget|ingot|dust|small_dust|tiny_dust|plate|double_plate|curved_plate|rod|long_rod|bolt|screw|ring|foil|gear|small_gear|rotor|spring|small_spring|round|wire_fine|frame|block)$/,
            /^gtceu:[a-z_]+_(hammer|file|wrench|screwdriver|saw|knife|mortar|crowbar|plunger|wire_cutter)$/,
            /^tfc:metal\//, "tfc:powder/flux", "tfc:bellows", "tfc:crucible", "tfc:ceramic/ingot_mold", "tfc:ceramic/fire_ingot_mold"] },
    { id: "builder", name: "Строитель", minTier: 1, goods: tgBuilder,
        buys: [/^tfc:(brick|mortar|fire_clay|kaolin_clay|thatch|straw)$/, /^tfc:brick\//, /^tfc:rock\/(cobble|bricks|smooth|raw|loose|hardened)\//,
            /^tfc:(fire_bricks|alabaster|plain_alabaster)/, "tfc:ceramic/fire_brick", "minecraft:clay_ball",
            /^gtceu:[a-z_]+_(hammer|saw)$/, /^tfc:metal\/chisel\//] },
    { id: "carpenter", name: "Плотник", minTier: 1, goods: tgCarpenter,
        buys: [/^tfc:wood\//, "tfc:wooden_bucket", /^gtceu:[a-z_]+_(saw|axe)$/, "tfc:straw", "tfc:thatch"] },
    { id: "potter", name: "Гончар", minTier: 1, goods: tgPotter,
        buys: [/^tfc:ceramic\//, "tfc:fire_clay", "tfc:kaolin_clay", "minecraft:clay_ball", "tfc:crucible", /^tfc:fire_bricks$/] },
    { id: "butcher", name: "Мясник", minTier: 1, goods: tier => tgFoodKind(tier, "butcher"),
        buys: [id => TG_MEAT.some(f => id === "tfc:food/" + f || id === "tfc:food/cooked_" + f), "tfc:powder/salt",
            /^gtceu:[a-z_]+_(knife|butchery_knife)$/, /^tfc:(small|medium|large)_raw_hide$/] },
    { id: "cook", name: "Повар", minTier: 1, goods: tier => tgFoodKind(tier, "cook"),
        buys: [/^tfc:food\//, /^firmalife:food\//, "tfc:powder/salt", "afc:maple_sugar"] },
    { id: "fisherman", name: "Рыбак", minTier: 1, goods: tier => tgFoodKind(tier, "fisherman"),
        buys: [id => TG_FISH.some(f => id === "tfc:food/" + f || id === "tfc:food/cooked_" + f),
            "tfc:food/shellfish", "tfc:food/fresh_seaweed", "tfc:food/dried_seaweed", /^tfc:metal\/fishing_rod\//] },
    { id: "hunter", name: "Охотник", minTier: 1, goods: tgHunter,
        buys: [/^tfc:(small|medium|large)_(raw|soaked|prepared|sheepskin)_hide$/, /^tfc:(small|medium|large)_sheepskin_hide$/,
            "minecraft:feather", "minecraft:bone", "minecraft:bow", "minecraft:arrow",
            id => TG_MEAT.some(f => id === "tfc:food/" + f), /^tfc:metal\/javelin\//] },
    { id: "gardener", name: "Садовник", minTier: 1, goods: tgGardener,
        buys: [/^tfc:seeds\//, /^tfc:wood\/sapling\//, /^tfc:food\//, "tfc:jute", "tfc:papyrus", "tfc:pumpkin", "tfc:melon",
            "tfc:powder/saltpeter", "gtceu:fertilizer", /^gtceu:[a-z_]+_(hoe|scythe)$/] },
    { id: "tailor", name: "Портной", minTier: 1, goods: tgTailor,
        buys: [/^tfc:(burlap_cloth|wool_cloth|silk_cloth|wool_yarn|wool|jute_fiber|jute|spindle|bone_needle)$/,
            /^tfc:(small|medium|large)_(soaked|prepared|sheepskin)_hide$/, /^tfc_textile:/, /^tfcambiental:(wool|silk|insulated)/,
            // одежда гардероба: шубы, наряды, платье жителей (цены - factions/wardrobe_prices.js)
            id => { try { var w = global.TFG_WARDROBE_PRICE(id); return !!w && w.kind === "cloth" } catch (e) { return false } }] },
    { id: "lumberjack", name: "Лесоруб", minTier: 1, goods: tgLumberjack,
        buys: [/^tfc:wood\/(log|lumber|sapling)\//, "minecraft:stick", "tfc:stick_bundle", /^tfc:metal\/axe\//, /^gtceu:[a-z_]+_axe$/] },
    { id: "quarryman", name: "Камнелом", minTier: 1, goods: tgQuarryman,
        buys: [/^tfc:rock\/(raw|cobble|loose|gravel|bricks)\//, /^tfc:brick\//, "tfc:powder/flux", /^tfc:metal\/chisel\//, /^gtceu:[a-z_]+_(pickaxe|hammer)$/] },
    { id: "miner", name: "Шахтёр", minTier: 1, goods: tgMiner,
        buys: [/^tfc:ore\//, /^tfc:powder\//, /^tfc:rock\/(loose|raw|cobble)\//, "tfc:torch", /^gtceu:[a-z_]+_(pickaxe|shovel|hammer|mining_hammer)$/,
            /^tfc:metal\/propick\//, /^gtceu:raw_/, /^gtceu:[a-z_]+_(crushed|crushed_purified|crushed_centrifuged|impure_dust|purified_dust)$/] },
    { id: "mechanic", name: "Механик", minTier: 3, goods: tgMechanic,
        buys: [/^create:/, /^createaddition:/, "gtceu:iron_gear", "gtceu:steel_gear"] },
    { id: "electrician", name: "Электрик", minTier: 4, goods: tgElectrician,
        buys: [/^gtceu:(lv|mv|hv|ev|iv|luv)_/, /^gtceu:[a-z_]+_(single|double|quadruple|octal|hex)_(cable|wire)$/,
            /^gtceu:(vacuum_tube|resistor|diode|capacitor|transistor|inductor|smd_)/, /^gtceu:[a-z_]+_electronic_circuit$/,
            /^gtceu:[a-z_]+_(processor|circuit_board|integrated_circuit)$/] },
    { id: "appraiser", name: "Оценщик", minTier: 1, special: true },
    { id: "buyer", name: "Скупщик", minTier: 1, special: true },
]

// ─── Ассортимент ─────────────────────────────────────────────────────────────

function tgOffers(kind, tier) {
    var list = kind.goods(tier)
    var seen = {}
    var out = []
    list.forEach(o => {
        // стволы и патроны TACZ - один предмет на всех, различаются они по gun/ammo
        var key = o.gun ? "gun:" + o.gun : o.ammo ? "ammo:" + o.ammo : o.item
        if (seen[key]) return
        seen[key] = true
        out.push(o)
    })
    return out
}

// ─── Скупка у игрока: подходит ли предмет виду и сколько стоит ───────────────

var TG_SELL_CACHE = {}

/** Цена предмета у этого вида по его же ассортименту (берём максимальную цену за штуку по всем тирам). */
function tgKindPrice(kind, id) {
    var table = TG_SELL_CACHE[kind.id]
    if (!table) {
        table = TG_SELL_CACHE[kind.id] = {}
        tgOffers(kind, 10).forEach(o => {
            var unit = o.price / Math.max(1, o.count) / 1.15         // без наценки торговца
            if (!table[o.item] || table[o.item] < unit) table[o.item] = unit
        })
    }
    return table[id] || 0
}

function tgMatches(rule, id) {
    if (typeof rule === "string") return id === rule
    // Регулярку проверяем раньше функции: в Rhino KubeJS typeof /.../ даёт "function",
    // и правило-регулярка вызывалось как функция, падало - и торговец не брал ничего,
    // кроме предметов, записанных строкой.
    if (rule instanceof RegExp) return rule.test(id)
    if (typeof rule === "function") return !!rule(id)
    return false
}

/** Скупает ли вид такой предмет. */
function tgKindBuys(kind, id) {
    if (!kind.buys) return false
    for (var i = 0; i < kind.buys.length; i++) if (tgMatches(kind.buys[i], id)) return true
    return false
}

/** Реальная цена штуки для этого вида (дробная, медяков), 0 - не его профиль. Износ снижает цену. */
function tgSellPrice(kindId, stack) {
    if (!stack || stack.isEmpty()) return 0
    var kind = TG_KINDS.filter(k => k.id === kindId)[0]
    if (!kind || !kind.goods) return 0
    var id = String(stack.id)
    // ствол и патрон TACZ оцениваем по тому, что это за ствол, а не по общему предмету
    var gunKey = null
    try { gunKey = global.TFG_GUN_ITEMS.stackKey(stack) } catch (e) { }
    if (gunKey) {
        if (!tgKindBuys(kind, id)) return 0
        return gunKey.indexOf("gun:") === 0 ? tgGunPrice(gunKey.substring(4)) : tgAmmoPrice(gunKey.substring(5))
    }
    if (id === "tacz:modern_kinetic_gun" || id === "tacz:ammo") return 0      // пустышка без id
    // свои правила вида или общая разметка рынка (factions/trade_market.js)
    var market = null
    if (!tgKindBuys(kind, id)) {
        try { market = global.TFG_MARKET.appraise(stack) } catch (e) { market = null }
        if (!market || market.kinds.indexOf(kindId) < 0) return 0
    }
    var unit = tgPrice(id)
    if (unit <= 0) unit = tgKindPrice(kind, id)
    if (unit <= 0 && market) unit = market.value
    if (unit <= 0) unit = 2                                          // профильная мелочь без прайса
    if (stack.isDamageableItem() && stack.getMaxDamage() > 0)
        unit *= Math.max(0, 1 - stack.getDamageValue() / stack.getMaxDamage())
    return unit
}

// ─── Скупщик ─────────────────────────────────────────────────────────────────

const TG_GEMS = { diamond: 2, emerald: 1.5, ruby: 1.5, sapphire: 1.5, green_sapphire: 1.2, topaz: 1, blue_topaz: 1,
    amethyst: 0.8, opal: 1, red_garnet: 0.8, yellow_garnet: 0.8 }
const TG_GEM_GRADES = { chipped_: 5, flawed_: 10, "": 25, flawless_: 60, exquisite_: 150 }
const TG_PRECIOUS = { gold: 1, platinum: 2, palladium: 1.5, rose_gold: 0.8, electrum: 0.8, silver: 0.6, sterling_silver: 0.5 }
const TG_PRECIOUS_FORMS = { nugget: 2, ingot: 20, rod: 10, plate: 20, foil: 5, ring: 10 }
const TG_BUY_FIXED = {
    "createdeco:copper_coin": 15,
    // Ключ был записан дважды, а в строгом режиме Rhino это ошибка: файл не грузился
    // целиком, и потому у торговца не было ни одного вида товара.
    "gtmutils:ancient_gold_coin": 200,
}

var TG_BUY_TABLE = null
function tgBuyTable() {
    if (TG_BUY_TABLE) return TG_BUY_TABLE
    TG_BUY_TABLE = {}
    for (var gem in TG_GEMS)
        for (var grade in TG_GEM_GRADES) TG_BUY_TABLE["gtceu:" + grade + gem + "_gem"] = Math.round(TG_GEM_GRADES[grade] * TG_GEMS[gem])
    for (var metal in TG_PRECIOUS)
        for (var form in TG_PRECIOUS_FORMS) TG_BUY_TABLE["gtceu:" + metal + "_" + form] = Math.max(1, Math.round(TG_PRECIOUS_FORMS[form] * TG_PRECIOUS[metal]))
    for (var id in TG_BUY_FIXED) TG_BUY_TABLE[id] = TG_BUY_FIXED[id]
    return TG_BUY_TABLE
}

/** Цена скупки за штуку в медяках; неверифицированные монеты - как безделушка. 0 - не скупает. */
function tgBuyPrice(stack) {
    if (!stack || stack.isEmpty()) return 0
    var coins = global.TFG_COINS
    if (coins && coins.isCoin(stack)) return coins.isVerified(stack) ? 0 : coins.trinket * (String(stack.id).indexOf("coinstack") >= 0 ? 4 : 1)
    // книги мира (factions/books.js): скупщик берёт по их ценности
    try { var book = global.TFG_BOOKS.valueOf(stack); if (book > 0) return book } catch (e) { }
    var fixed = tgBuyTable()[String(stack.id)] || 0
    // Скупщик берёт драгоценное дороже всех: по своей таблице или по оценке рынка с надбавкой.
    var market = 0
    try { market = global.TFG_MARKET.precious(stack) } catch (e) { }
    // гравированное - дороже, памятное - ещё дороже (factions/engraving.js)
    try { if (global.TFG_ENGRAVE) return global.TFG_ENGRAVE.value(stack, Math.max(fixed, market)) } catch (e) { }
    return Math.max(fixed, market)
}

/** Старьёвщик: любая вещь, кроме денег, за треть цены. Непродаваемых вещей нет. */
function tgJunkPrice(stack) {
    if (!stack || stack.isEmpty()) return 0
    var coins = global.TFG_COINS
    if (coins && coins.isCoin(stack)) return 0
    var junk = 0
    try { junk = global.TFG_MARKET.junk(stack) } catch (e) { return 0 }
    // Старьёвщик никогда не платит больше мастера: иначе к мастерам никто не пойдёт.
    var best = 0
    try {
        global.TFG_MARKET.appraise(stack).kinds.forEach(k => {
            var p = tgSellPrice(k, stack)
            if (p > best) best = p
        })
    } catch (e) { }
    return best > 0 ? Math.min(junk, best * 0.6) : junk
}

// ─── Специализации торговцев ─────────────────────────────────────────────────
//
// Именной торговец везёт не весь ассортимент вида, а своё: кузнец по мягким металлам,
// кузнец по железу и стали, торговец инструментом. Специализацию выбирает factions/trader.js
// по личности торговца (у одного и того же человека она всегда одна), там же набирается
// случайная часть товара. Виды без специализаций просто берут случайную часть.

/** Металл предмета по его id (gtceu:<металл>_<форма>, tfc:metal/<вещь>/<металл>) или null. */
function tgMetalOf(id) {
    var m = String(id).match(/^tfc:metal\/[a-z_]+\/([a-z_]+)$/)
    if (m && TG_METAL_BY_ID[m[1]]) return TG_METAL_BY_ID[m[1]]
    m = String(id).match(/^gtceu:([a-z_]+?)_(nugget|ingot|dust|plate|rod|bolt|screw|ring|foil|gear|hammer|file|wrench|screwdriver|sword|axe|spear|knife|butchery_knife|saw|pickaxe|shovel|hoe|scythe)$/)
    if (m && TG_METAL_BY_ID[m[1]]) return TG_METAL_BY_ID[m[1]]
    return null
}

function tgSimpleGun(o) {
    try { return !!(o.gun && global.TFG_GUNS[o.gun] && global.TFG_GUNS[o.gun][1]) } catch (e) { return false }
}

const TG_SPECS = {
    blacksmith: [
        { id: "soft", name: "мягкие металлы", match: o => { var m = tgMetalOf(o.item); return !!m && m.tier <= 2 } },
        { id: "iron", name: "железо и сталь", match: o => { var m = tgMetalOf(o.item); return !!m && m.tier >= 3 } },
        { id: "tools", name: "инструменты", match: o => /_(hammer|file|wrench|screwdriver)$|^tfc:metal\/(anvil|tuyere|chisel|bars|chain)\/|bellows|crucible|flux/.test(o.item) },
    ],
    weaponsmith: [
        { id: "blades", name: "клинки", match: o => /_(sword|knife)$/.test(o.item) },
        { id: "heavy", name: "древко и булавы", match: o => /(_spear$|_axe$|metal\/(mace|javelin)\/)/.test(o.item) },
        { id: "ranged", name: "луки и стрелы", match: o => /(bow|crossbow|arrow)/.test(o.item) },
    ],
    armorer: [
        { id: "plate", name: "латы", match: o => /(helmet|chestplate|greaves|boots)/.test(o.item) },
        { id: "light", name: "щиты и кожа", match: o => /(shield|insulated|hide)/.test(o.item) },
    ],
    gunsmith: [
        { id: "pistols", name: "пистолеты и дробовики", match: o => tgSimpleGun(o) || !!o.ammo },
        { id: "rifles", name: "винтовки и тяжёлое", match: o => (!!o.gun && !tgSimpleGun(o)) || !!o.ammo },
    ],
    miner: [
        { id: "ore", name: "руда", match: o => /^tfc:ore\//.test(o.item) },
        { id: "stone", name: "камень и порошки", match: o => /(powder|rock|torch|propick)/.test(o.item) },
    ],
}

/** Расходный товар: им торгуют горой, а не штуками (слитки, руда, еда, доски, патроны). */
const TG_BULK = /_(ingot|nugget|plate|rod|bolt|screw|ring|foil|dust|gear)$|^tfc:ore\/|powder|food\/|seeds\/|lumber|brick|mortar|thatch|straw|cloth|wool|yarn|fiber|arrow|rock\/|^tacz:ammo$|clay|glue|salt/

global.TFG_TRADE_GOODS = {
    specs: kindId => TG_SPECS[kindId] || [],
    bulk: o => !!o && !o.gun && TG_BULK.test(String(o.item)),
    kinds: TG_KINDS,
    kind: id => TG_KINDS.filter(k => k.id === id)[0] || null,
    /** Виды, которые приходят к игроку этого тира (без оценщика и скупщика). */
    kindsFor: tier => TG_KINDS.filter(k => !k.special && k.minTier <= tier),
    offers: (kindId, tier) => {
        var k = TG_KINDS.filter(x => x.id === kindId)[0]
        return k && k.goods ? tgOffers(k, Math.max(1, Math.min(10, tier))) : []
    },
    sellPrice: (kindId, stack) => tgSellPrice(kindId, stack),
    buyPrice: stack => tgBuyPrice(stack),
    junkPrice: stack => tgJunkPrice(stack),
    itemPrice: id => tgPrice(id),
}

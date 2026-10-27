// priority: 0
"use strict";
/**
 * Ice and Fire под TFG: снаряжение мода встаёт в лестницу металлов сборки, а не рядом с ней.
 *
 * Монстровый материал не заменяет металл, а улучшает его: каждая вещь собирается на основе
 * доспеха или инструмента TFG своего тира, и чем опаснее зверь, тем дороже основа.
 *   тролличья кожа          - доспех бронзы,           верстак;
 *   хитин червя и мирмексов - кованое железо,          верстак;
 *   чешуя морского змея     - сталь,                   верстак;
 *   драконья чешуя и кость  - чёрная сталь,            сборщик LV;
 *   драконья сталь          - синяя сталь,             сборщик MV (слиток - в драконьей кузнице
 *                                                      из синей стали, а не из железа).
 * Медные доспехи и инструменты мода - дубли TFC, их рецепты убраны. Серебряные остались
 * (бьют нежить больнее), но куются из пластин GregTech. Ванильная основа (железо, каменный
 * кирпич, шерсть, блоки металлов) заменена материалами сборки.
 */

const IAF_PIECES = [                 // кусок мода -> кусок доспеха TFC
    ["helmet", "helmet"], ["chestplate", "chestplate"], ["leggings", "greaves"], ["boots", "boots"],
]
// доспех TFC в середине, монстровый материал вокруг
const IAF_RING = {
    helmet: ["MMM", "MAM"],
    chestplate: ["MAM", "MMM", "MMM"],
    leggings: ["MMM", "MAM", "M M"],
    boots: ["M M", "MAM"],
}
const IAF_SCALES = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 }        // драконья чешуя
const IAF_STEEL = { helmet: 3, chestplate: 5, leggings: 4, boots: 2 }         // слитки драконьей стали
const IAF_TOOLS = ["sword", "pickaxe", "axe", "shovel", "hoe"]
const IAF_TOOL_COST = { sword: 2, pickaxe: 3, axe: 3, shovel: 1, hoe: 2 }

const IAF_DRAGON_COLORS = ["amythest", "black", "blue", "bronze", "copper", "electric", "gray", "green",
    "red", "sapphire", "silver", "white"]
const IAF_TIDE_COLORS = ["blue", "bronze", "deepblue", "green", "purple", "red", "teal"]
const IAF_ELEMENTS = ["fire", "ice", "lightning"]

ServerEvents.recipes(event => {
    const out = id => "iceandfire:" + id

    // ─── Монстровые доспехи на верстаке: доспех TFC + материал ───────────────
    function mobArmor(prefix, material, metal, extraHelmet) {
        IAF_PIECES.forEach(p => {
            var id = prefix + "_" + p[0]
            event.remove({ output: out(id) })
            var pattern = IAF_RING[p[0]].slice()
            var key = { M: material, A: "tfc:metal/" + p[1] + "/" + metal }
            if (p[0] === "helmet" && extraHelmet) { pattern[0] = "MTM"; key.T = extraHelmet }
            event.shaped(out(id), pattern, key).id("tfg:iceandfire/armor/" + id)
        })
    }
    ;["forest", "frost", "mountain"].forEach(t =>
        mobArmor(t + "_troll_leather", "iceandfire:troll_leather_" + t, "bronze", "iceandfire:troll_tusk"))
    ;["red", "white", "yellow"].forEach(c =>
        mobArmor("deathworm_" + c, "iceandfire:deathworm_chitin_" + c, "wrought_iron"))
    ;["desert", "jungle"].forEach(c =>
        mobArmor("myrmex_" + c, "iceandfire:myrmex_" + c + "_chitin", "wrought_iron"))
    IAF_TIDE_COLORS.forEach(c =>
        mobArmor("tide_" + c, "iceandfire:sea_serpent_scales_" + c, "steel"))

    // ─── Драконья чешуя: сборщик LV, основа - доспех чёрной стали ────────────
    IAF_DRAGON_COLORS.forEach(c => {
        IAF_PIECES.forEach(p => {
            var id = "armor_" + c + "_" + p[0]
            event.remove({ output: out(id) })
            event.recipes.gtceu.assembler("tfg:iceandfire/assembler/" + id)
                .itemInputs("tfc:metal/" + p[1] + "/black_steel", IAF_SCALES[p[0]] + "x iceandfire:dragonscales_" + c)
                .itemOutputs(out(id))
                .duration(600)
                .EUt(GTValues.VA[GTValues.LV])
        })
    })

    // ─── Драконья кость: сборщик LV, основа - инструмент чёрной стали ────────
    IAF_TOOLS.forEach(t => {
        var id = "dragonbone_" + t
        event.remove({ output: out(id) })
        event.recipes.gtceu.assembler("tfg:iceandfire/assembler/" + id)
            .itemInputs("gtceu:black_steel_" + t, IAF_TOOL_COST[t] + "x iceandfire:dragonbone", "#forge:bones/wither")
            .itemOutputs(out(id))
            .duration(400)
            .EUt(GTValues.VA[GTValues.LV])
    })
    event.remove({ output: out("dragonbone_bow") })
    event.recipes.gtceu.assembler("tfg:iceandfire/assembler/dragonbone_bow")
        .itemInputs("minecraft:bow", "3x iceandfire:dragonbone", "2x #forge:plates/black_steel", "#forge:bones/wither")
        .itemOutputs(out("dragonbone_bow"))
        .duration(400)
        .EUt(GTValues.VA[GTValues.LV])

    // ─── Драконья сталь: кузница плавит синюю сталь; вещи - сборщик MV ───────
    IAF_ELEMENTS.forEach(e => {
        var ingot = out("dragonsteel_" + e + "_ingot")
        event.remove({ output: ingot })
        event.custom({
            type: "iceandfire:dragonforge", dragon_type: e, cook_time: 1000,
            input: { item: "gtceu:blue_steel_ingot" },
            blood: { item: out(e + "_dragon_blood") },
            result: { item: ingot },
        }).id("tfg:iceandfire/dragonforge/" + e)
        // Второй путь - сборщик MV: рецепты драконьей кузницы EMI может не показывать,
        // и тогда кажется, что драконьей стали нет вовсе. Кузница выгоднее: тут кровь - вдвое.
        event.recipes.gtceu.assembler("tfg:iceandfire/assembler/dragonsteel_" + e + "_ingot")
            .itemInputs("gtceu:blue_steel_ingot", "2x " + out(e + "_dragon_blood"))
            .itemOutputs(ingot)
            .duration(1200)
            .EUt(GTValues.VA[GTValues.MV])
        IAF_PIECES.forEach(p => {
            var id = "dragonsteel_" + e + "_" + p[0]
            event.remove({ output: out(id) })
            event.recipes.gtceu.assembler("tfg:iceandfire/assembler/" + id)
                .itemInputs("tfc:metal/" + p[1] + "/blue_steel", IAF_STEEL[p[0]] + "x " + ingot)
                .itemOutputs(out(id))
                .duration(900)
                .EUt(GTValues.VA[GTValues.MV])
        })
        IAF_TOOLS.forEach(t => {
            var id = "dragonsteel_" + e + "_" + t
            event.remove({ output: out(id) })
            event.recipes.gtceu.assembler("tfg:iceandfire/assembler/" + id)
                .itemInputs("gtceu:blue_steel_" + t, IAF_TOOL_COST[t] + "x " + ingot, "#forge:bones/wither")
                .itemOutputs(out(id))
                .duration(900)
                .EUt(GTValues.VA[GTValues.MV])
        })
    })

    // ─── Хитин мирмексов: инструменты на основе кованого железа ──────────────
    ;["desert", "jungle"].forEach(c => {
        IAF_TOOLS.forEach(t => {
            var id = "myrmex_" + c + "_" + t
            event.remove({ output: out(id) })
            event.shapeless(out(id), ["gtceu:wrought_iron_" + t, "2x iceandfire:myrmex_" + c + "_chitin", "#forge:bones/wither"])
                .id("tfg:iceandfire/tool/" + id)
        })
    })

    // ─── Серебро мода: из пластин GregTech ───────────────────────────────────
    var silverArmor = {
        helmet: ["PPP", "P P"], chestplate: ["D D", "DDD", "DDD"], leggings: ["DDD", "D D", "D D"], boots: ["P P", "P P"],
    }
    IAF_PIECES.forEach(p => {
        var id = "armor_silver_metal_" + p[0]
        event.remove({ output: out(id) })
        event.shaped(out(id), silverArmor[p[0]], { P: "#forge:plates/silver", D: "#forge:double_plates/silver" })
            .id("tfg:iceandfire/armor/" + id)
    })
    var silverTools = {
        sword: ["P", "P", "S"], pickaxe: ["PPP", " S ", " S "], axe: ["PP", "PS", " S"], shovel: ["P", "S", "S"], hoe: ["PP", " S", " S"],
    }
    IAF_TOOLS.forEach(t => {
        var id = "silver_" + t
        event.remove({ output: out(id) })
        event.shaped(out(id), silverTools[t], { P: "#forge:plates/silver", S: "#forge:rods/wooden" })
            .id("tfg:iceandfire/tool/" + id)
    })
    // переплавка серебра и меди мода в самородки - лишняя дыра в экономике
    event.remove({ output: out("silver_nugget"), type: "minecraft:smelting" })
    event.remove({ output: out("silver_nugget"), type: "minecraft:blasting" })

    // ─── Медь мода - дубль TFC: убираем ──────────────────────────────────────
    IAF_TOOLS.forEach(t => event.remove({ output: out("copper_" + t) }))
    IAF_PIECES.forEach(p => event.remove({ output: out("armor_copper_metal_" + p[0]) }))
    event.remove({ output: out("copper_nugget") })

    // ─── Ванильная основа -> материалы сборки ────────────────────────────────
    event.replaceInput({ mod: "iceandfire" }, "#forge:ingots/iron", "gtceu:steel_ingot")
    event.replaceInput({ mod: "iceandfire" }, "minecraft:stone_bricks", "#tfc:rock/bricks")
    event.replaceInput({ mod: "iceandfire" }, "#forge:storage_blocks/iron", "#forge:storage_blocks/steel")
    event.replaceInput({ mod: "iceandfire" }, "#forge:storage_blocks/copper", "#forge:storage_blocks/bronze")
    event.replaceInput({ mod: "iceandfire" }, "minecraft:white_wool", "tfc:wool_cloth")
})

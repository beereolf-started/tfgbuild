// priority: 0
"use strict";

/**
 * КРАФТЫ ИНСТРУМЕНТОВ ПОД TFG.
 *
 * Свои рецепты Immersive Melodies опираются на ванильные доски, брёвна, нотные блоки и ванильные слитки меди и
 * железа - в сборке это тупик (ванильные доски и брёвна отключены, металлы идут через GregTech и TFC).
 * Поэтому рецепты мода убираются, а взамен - те же инструменты из того, что в TFG действительно добывается:
 * пиломатериалы и доски TFC, жила и пряжа, выделанные шкуры, кости, пластины GregTech.
 */

const IM_LUMBER = "#tfc:lumber"
const IM_PLANKS = "#minecraft:planks"
const IM_STICK = "minecraft:stick"
const IM_BONE = "minecraft:bone"
const IM_YARN = "tfc:wool_yarn"
const IM_HIDE = "tfc:medium_prepared_hide"
const IM_SMALL_HIDE = "tfc:small_prepared_hide"
const IM_COPPER = "#forge:plates/copper"
const IM_IRON = "#forge:plates/wrought_iron"
const IM_STEEL = "#forge:plates/steel"

ServerEvents.recipes(event => {
    event.remove({ mod: "immersive_melodies" })

    // флейта - кость и палки
    event.shaped("immersive_melodies:flute", ["  B", " S ", "S  "], { B: IM_BONE, S: IM_STICK })
    // лютня и виелла - дерево, жила и пряжа
    event.shaped("immersive_melodies:lute", ["  I", "PS ", "PP "], { I: IM_STICK, S: IM_YARN, P: IM_LUMBER })
    event.shaped("immersive_melodies:vielle", ["  I", "WS ", "WW "], { I: IM_STICK, S: IM_YARN, W: IM_PLANKS })
    // барабан и волынка - шкуры
    event.shaped("immersive_melodies:tiny_drum", ["LLL", "SWS", "   "], { L: IM_SMALL_HIDE, S: IM_YARN, W: IM_PLANKS })
    event.shaped("immersive_melodies:bagpipe", ["FF ", "LLF", "LLL"], { F: "immersive_melodies:flute", L: IM_HIDE })
    // диджериду - выдолбленное бревно и клей
    event.shaped("immersive_melodies:didgeridoo", ["P  ", " PG", "  P"], { P: IM_PLANKS, G: "tfc:glue" })
    // металлические: медные пластины, кованое железо, сталь
    event.shaped("immersive_melodies:triangle", [" C ", "C C", "CCC"], { C: IM_COPPER })
    event.shaped("immersive_melodies:trumpet", ["ICC", " IC", "   "], { I: IM_IRON, C: IM_COPPER })
    event.shaped("immersive_melodies:handpan", ["CCC", "III", "   "], { C: IM_COPPER, I: IM_IRON })
    // пианино и эндер-бас - поздние, на стали
    event.shaped("immersive_melodies:piano", ["BBB", "SSS", "PPP"], { B: IM_BONE, S: IM_STEEL, P: IM_PLANKS })
    event.shaped("immersive_melodies:ender_bass", [" E ", "SPS", " P "], { E: "minecraft:ender_pearl", S: IM_STEEL, P: IM_PLANKS })
})

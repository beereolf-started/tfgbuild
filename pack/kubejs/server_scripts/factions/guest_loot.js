// priority: 0
"use strict";

/**
 * ДОБЫЧА С ГОСТЕЙ ФРАКЦИЙ (factions/guests.js, factions/trader.js): скромная и по теме, как у разбойников, вместо
 * ванильной добычи хаска (гнилая плоть). Стражи - хаски с тегом tfg_guest, торговцы - tfg_trader.
 * Условие по тегу - SNBT-строкой (matchEntity(e.nbt({...})) в этом LootJS не срабатывает, см. primitive_creatures/loot.js).
 * Монеты - верифицированные (factions/coins.js): их принимают торговцы всех фракций по номиналу.
 * Стрелы с лучников и арбалетчиков - в EntityEvents.death в factions/guests.js.
 *
 * Паёк - не безымянный сыр и жареный стейк, а то, что в сборке действительно есть: сыры FirmaLife по происхождению
 * (чеддер, шевр, фета, гауда, шоша, раджья-метокя, козий и ячий творог) и готовые блюда TFC Gourmet
 * (братвурст, котлеты по-киевски, пельмени, вареники, хачапури, борщ, гуляш и прочее).
 */

const GL_CHEESE = ["firmalife:food/cheddar", "firmalife:food/chevre", "firmalife:food/feta", "firmalife:food/gouda",
    "firmalife:food/shosha", "firmalife:food/rajya_metok", "firmalife:food/goat_curd", "firmalife:food/yak_curd",
    "firmalife:food/shredded_cheese", "tfc:food/cheese"]
const GL_DISHES = ["tfc_gourmet:bratwurst", "tfc_gourmet:kiev_cutlets", "tfc_gourmet:pelmeni", "tfc_gourmet:vareniki",
    "tfc_gourmet:syrniki", "tfc_gourmet:chebureki", "tfc_gourmet:dolma", "tfc_gourmet:khachapuri", "tfc_gourmet:borscht",
    "tfc_gourmet:goulash", "tfc_gourmet:crepes", "tfc_gourmet:oladyi", "tfc_gourmet:falafel", "tfc_gourmet:hummus",
    "tfc_gourmet:greek_salad", "tfc_gourmet:fried_rice", "tfc_gourmet:curry", "tfc_gourmet:biryani", "tfc_gourmet:bulgogi",
    "tfc_gourmet:kharcho", "tfc_gourmet:fish_soup", "tfc_gourmet:four_cheeses_pizza", "tfc_gourmet:margarita_pizza",
    "firmalife:food/cooked_pizza", "firmalife:food/cooked_lasagna", "firmalife:food/cooked_pasta",
    "firmalife:food/cooked_pie", "firmalife:food/garlic_bread"]
const GL_BREAD = ["tfc:food/wheat_bread", "tfc:food/barley_bread", "tfc:food/rye_bread", "tfc:food/oat_bread",
    "tfc:food/maize_bread", "tfc:food/rice_bread"]

/** Верифицированная монета - как её делает factions/coins.js (NBT tfg_verified и подпись). */
function glCoin(id, count) {
    return Item.of(id, count, { tfg_verified: true, display: { Lore: [JSON.stringify({ text: "Верифицировано", color: "green", italic: false })] } })
}

function glTag(tag) {
    return { condition: "minecraft:entity_properties", entity: "this", predicate: { nbt: '{Tags:["' + tag + '"]}' } }
}

/** Предметы, которых на сервере нет, из таблицы убираем - иначе добыча не выпадет вовсе. */
function glItems(list) {
    return list.filter(id => {
        try { return !Item.of(id).isEmpty() } catch (e) { return false }
    })
}

LootJS.modifiers(event => {
    var guard = () => event.addEntityLootModifier("minecraft:husk").customCondition(glTag("tfg_guest"))
    var trader = () => event.addEntityLootModifier("minecraft:husk").customCondition(glTag("tfg_trader"))

    // страж: хлеб в дорогу, иногда сыр, горячее, факелы, ткань, соль или пара медяков
    guard().removeLoot(ItemFilter.ALWAYS_TRUE).addWeightedLoot([1, 2], glItems(GL_BREAD))
    guard().randomChance(0.35).addWeightedLoot([1, 1], glItems(GL_CHEESE))
    guard().randomChance(0.3).addWeightedLoot([1, 1], glItems(GL_DISHES))
    guard().randomChance(0.25).addWeightedLoot([1, 3], ["tfc:torch"])
    guard().randomChance(0.2).addWeightedLoot([1, 2], ["tfc:burlap_cloth", "tfc:wool_yarn", "tfc:jute_fiber"])
    guard().randomChance(0.1).addWeightedLoot([2, 4], ["tfc:powder/salt"])
    guard().randomChance(0.3).addWeightedLoot([glCoin("createdeco:copper_coin", 1), glCoin("createdeco:copper_coin", 2), glCoin("createdeco:copper_coin", 3)])

    // торговец: кошель мелочи, бумаги, обед получше
    trader().removeLoot(ItemFilter.ALWAYS_TRUE)
        .addWeightedLoot([glCoin("createdeco:copper_coin", 2), glCoin("createdeco:copper_coin", 4), glCoin("createdeco:copper_coin", 6)])
        .addWeightedLoot([1, 3], ["minecraft:paper"])
    trader().randomChance(0.6).addWeightedLoot([1, 2], glItems(GL_DISHES))
    trader().randomChance(0.4).addWeightedLoot([1, 1], glItems(GL_CHEESE))
    trader().randomChance(0.5).addWeightedLoot([glCoin("createdeco:zinc_coin", 1), glCoin("createdeco:zinc_coin", 2)])
    trader().randomChance(0.15).addLoot(glCoin("createdeco:brass_coin", 1))
})

"use strict";
/**
 * СТВОЛЫ И ПАТРОНЫ TACZ КАК ПРЕДМЕТЫ.
 *
 * В TACZ все стволы - один предмет tacz:modern_kinetic_gun, а какой это ствол, решает GunId
 * в NBT; патроны так же: tacz:ammo + AmmoId. Предмет без этого поля TACZ рисует пустышкой -
 * фиолетово-чёрной сеткой и без свойств. Поэтому собираем их штатными сборщиками мода
 * (как бандиты в primitive_creatures/bandit_roles.js), а NBT строкой - только запасной путь,
 * и каждый готовый предмет проверяем: есть ли в нём нужный id.
 *
 * Пользуются: постройки (factions/structures.js), ружейник (factions/trade_goods.js),
 * окно сделки (factions/trade_menu.js), стоянки караванов (factions/camps.js).
 * Предложение торговца со стволом несёт поле gun, с патронами - поле ammo.
 */

const GI_RL = Java.loadClass("net.minecraft.resources.ResourceLocation")
const GI_GunBuilder = Java.loadClass("com.tacz.guns.api.item.builder.GunItemBuilder")
const GI_AmmoBuilder = Java.loadClass("com.tacz.guns.api.item.builder.AmmoItemBuilder")
const GI_Assets = Java.loadClass("com.tacz.guns.resource.CommonAssetsManager")
const GI_GUN_ITEM = "tacz:modern_kinetic_gun"
const GI_AMMO_ITEM = "tacz:ammo"

var GI_TOLD = {}

function giErr(what, e) {
    if (GI_TOLD[what]) return
    GI_TOLD[what] = true
    try { global.tfgLogError("tfg guns", what, e) } catch (err) { console.error("[tfg guns] " + what + ": " + e) }
}

function giRl(id) {
    var p = String(id).split(":")
    return p.length > 1 ? new GI_RL(p[0], p[1]) : new GI_RL("tacz", p[0])
}

const GI_Timeless = Java.loadClass("com.tacz.guns.api.TimelessAPI")

/** Есть ли такой ствол в реестре TACZ этой установки (ганпак может не стоять). */
function giGunLoaded(id) {
    try { return GI_Assets.getInstance().getGunIndex(giRl(id)) != null } catch (e) { return false }
}

/**
 * Настоящий ли это патрон. У холодного оружия ганпаков в поле патрона стоит "melee" -
 * такого патрона нет, и предмет с ним выходит пустышкой.
 */
function giAmmoLoaded(id) {
    if (!id || String(id).indexOf("melee") >= 0) return false
    try { return GI_Timeless.getCommonAmmoIndex(giRl(id)).isPresent() } catch (e) { giErr("проверка патрона", e) }
    return true                     // проверить не вышло - не запрещаем, кроме melee
}

/** Несёт ли предмет нужный id в NBT (GunId / AmmoId). */
function giHas(stack, key, id) {
    if (!stack || stack.isEmpty()) return false
    var nbt = ""
    try { nbt = String(stack.nbt) } catch (e) { return false }
    return nbt.indexOf(key) >= 0 && nbt.indexOf('"' + id + '"') >= 0
}

/** Ствол без патронов в магазине. null, если ствола нет. */
function giGun(id) {
    if (!giGunLoaded(id)) return null
    var st = null
    try {
        st = GI_GunBuilder.create().setId(giRl(id)).setCount(1).setAmmoCount(0).setAmmoInBarrel(false).build()
    } catch (e) { giErr("сборка ствола " + id, e) }
    if (giHas(st, "GunId", id)) return st
    try { st = Item.of(GI_GUN_ITEM, 1, { GunId: String(id), GunFireMode: "SEMI" }) } catch (e) { st = null }
    if (giHas(st, "GunId", id)) return st
    giErr("ствол " + id + " не собрался", "пустой предмет")
    return null
}

/** Стопка патронов. null, если патрон не собрался. */
function giAmmo(id, count) {
    if (!giAmmoLoaded(id)) return null
    var n = Math.max(1, count || 1)
    var st = null
    try {
        st = GI_AmmoBuilder.create().setId(giRl(id)).setCount(n).build()
    } catch (e) { giErr("сборка патрона " + id, e) }
    if (giHas(st, "AmmoId", id)) return st
    try { st = Item.of(GI_AMMO_ITEM, n, { AmmoId: String(id) }) } catch (e) { st = null }
    if (giHas(st, "AmmoId", id)) return st
    giErr("патрон " + id + " не собрался", "пустой предмет")
    return null
}

/** Предмет предложения торговца: ствол, патроны или обычная вещь. */
function giOfferStack(o, count) {
    if (!o) return null
    if (o.gun) return giGun(o.gun)
    if (o.ammo) return giAmmo(o.ammo, count)
    try {
        var st = Item.of(o.item, Math.max(1, count || 1))
        return st && !st.isEmpty() ? st : null
    } catch (e) { return null }
}

/** NBT предложения строкой - для команд вроде data merge (стоянки караванов). */
function giOfferSnbt(o) {
    if (o && o.gun) return '{GunId:"' + o.gun + '",GunFireMode:"SEMI",GunCurrentAmmoCount:0,HasBulletInBarrel:0b}'
    if (o && o.ammo) return '{AmmoId:"' + o.ammo + '"}'
    return null
}

/** NBT предложения объектом - для иконок окна (к нему дописывается display). */
function giOfferTag(o) {
    if (o && o.gun) return { GunId: String(o.gun), GunFireMode: "SEMI" }
    if (o && o.ammo) return { AmmoId: String(o.ammo) }
    return null
}

/** Какой это ствол или патрон: "gun:<id>", "ammo:<id>" или null для прочих вещей. */
function giStackKey(stack) {
    if (!stack || stack.isEmpty()) return null
    var id = String(stack.id)
    if (id !== GI_GUN_ITEM && id !== GI_AMMO_ITEM) return null
    var m = null
    try { m = String(stack.nbt).match(id === GI_GUN_ITEM ? /GunId:"([^"]+)"/ : /AmmoId:"([^"]+)"/) } catch (e) { }
    return m ? (id === GI_GUN_ITEM ? "gun:" : "ammo:") + m[1] : null
}

global.TFG_GUN_ITEMS = {
    GUN_ITEM: GI_GUN_ITEM,
    AMMO_ITEM: GI_AMMO_ITEM,
    loaded: id => giGunLoaded(id),
    ammoLoaded: id => giAmmoLoaded(id),
    gun: id => giGun(id),
    ammo: (id, count) => giAmmo(id, count),
    offerStack: (o, count) => giOfferStack(o, count),
    offerSnbt: o => giOfferSnbt(o),
    offerTag: o => giOfferTag(o),
    stackKey: stack => giStackKey(stack),
}

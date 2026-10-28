// priority: 0
"use strict";

/**
 * 30 новых "ролей" для разбойничьих лагерей (мобы primitive_creatures, которые пак
 * уже расставляет через tfg:illagers/mob_weak, mob_strong, mob_ranged, mob_outdoors,
 * mob_gatherer - см. kubejs/data/tfg/worldgen/template_pool/illagers/*.json).
 *
 * Ничего в ворлдгене трогать не нужно - все эти мобы и так уже спавнятся в лагерях,
 * просто сейчас у них пустые руки (проверено побайтовым разбором NBT структур
 * illager_generic/mobs/*.nbt - ни оружия, ни брони ни у одного). Этот скрипт вешает
 * на каждый спавн такого моба случайную роль из таблицы ниже: оружие (ближний бой
 * из TFC-металлов или огнестрел TACZ), броню (там где логично) и бонус к HP/броне.
 *
 * TACZ: любой LivingEntity (не только игрок) - валидный "gun operator" за счёт
 * миксина com.tacz.guns.mixin.common.LivingEntityMixin на сам LivingEntity, и это
 * подтверждено тем, что структуры mercenary/warrior уже несли компонент
 * tacz:synced_entity_data ещё до этого фикса. Стрелять моб решает сам (это уже
 * внутренняя логика TACZ/примитивных мобов, не наша), наша часть - только выдать
 * оружие и настроить "холостой" боезапас через IGun.setDummyAmmoAmount/
 * setMaxDummyAmmoAmount (в TACZ это официальный путь для NPC без инвентаря с
 * патронами - см. com.tacz.guns.api.item.IGun). Если после теста окажется, что
 * мобы держат оружие, но не стреляют - значит для авто-стрельбы всё-таки нужен
 * отдельный AI Goal, дайте знать, дособерём.
 */

const EquipmentSlotClass = Java.loadClass("net.minecraft.world.entity.EquipmentSlot")
const SLOT_HEAD = EquipmentSlotClass.HEAD
const SLOT_CHEST = EquipmentSlotClass.CHEST
const SLOT_LEGS = EquipmentSlotClass.LEGS
const SLOT_FEET = EquipmentSlotClass.FEET
const SLOT_MAINHAND = EquipmentSlotClass.MAINHAND
const SLOT_OFFHAND = EquipmentSlotClass.OFFHAND

// Рейдеры хрупче обычных бандитов: итоговое здоровье x0.6. Живучесть почти целиком
// шла от бонуса роли (+4..+45) к базовым 20-30 HP мода, а отряды стали крупнее.
const RAID_MEMBER_HEALTH_MULT = 0.6

// ID стволов НИЖЕ (в таблице ROLES) - ПОЛНЫЕ "namespace:id", подтверждённые
// напрямую из работающей игры через CommonAssetsManager.getAllGuns() (см.
// raidLogKnownGunIds ниже), а не по файлам на диске и не по памяти о
// ванильном TACZ. Два предыдущих захода мимо: сначала были откровенно
// выдуманные "tacz:flintlock_pistol" и т.п., потом - реальные, но НЕ
// установленные в этом паке стволы ванильного tacz_default_gun (ak47,
// glock_17, scar_h...) - у этой сборки ГАН-ПАК ДРУГОЙ: реальные стволы идут
// из create_armorer, applied_armorer, ulv_guns, и только 4 - из vanilla tacz
// (m700, springfield1873, db_short, db_long). Жёстко зашитый namespace
// "tacz:" в билдере ствола (см. tfgGunStack) был отдельной причиной провала
// даже для тех 4 правильных id - теперь namespace берётся из самой строки.
const RAID_ResourceLocationClass = Java.loadClass("net.minecraft.resources.ResourceLocation")
const RAID_GunItemBuilderClass = Java.loadClass("com.tacz.guns.api.item.builder.GunItemBuilder")
const RAID_CommonAssetsManagerClass = Java.loadClass("com.tacz.guns.resource.CommonAssetsManager")

/**
 * GunItemBuilder.build() при неудачном поиске id молча возвращает пустой
 * предмет БЕЗ исключения (см. декомпиляцию - TimelessAPI.getCommonGunIndex
 * возвращает пустой Optional, а build() на пустом Optional просто делает
 * return ItemStack.EMPTY). Раньше это было невозможно отличить от "всё ок".
 *
 * CommonAssetsManager.getInstance().getAllGuns() отдаёт РЕАЛЬНЫЙ список всех
 * загруженных в данный момент стволов прямо из работающей игры - это
 * единственный стопроцентный источник истины по именам id, не зависящий от
 * того, правильно ли я угадал формат по файлам ганпака на диске. Печатаем
 * его в лог один раз при первом обращении - следующий тест покажет
 * буквально ПОЛНЫЙ список того, что реально можно выдать, без всяких догадок.
 */
/**
 * Загружен ли сейчас реестр стволов. Во время /reload он пуст, и любой
 * GunItemBuilder.build() тихо вернёт ItemStack.EMPTY - см. комментарий в
 * EntityEvents.spawned ниже. Не кэшируем: состояние меняется по ходу игры.
 */
function tfgGunsAvailable() {
	try {
		return RAID_CommonAssetsManagerClass.getInstance().getAllGuns().size() > 0
	} catch (e) {
		return false
	}
}

// tfg/events.js спрашивает это перед тем, как назначить рейдеру роль стрелка:
// пока реестр пуст, стрелок вышел бы с пустыми руками и скином винтовки
global.TFG_GUNS_AVAILABLE = tfgGunsAvailable

var RAID_knownGunIdsLogged = false
function raidLogKnownGunIds() {
	if (RAID_knownGunIdsLogged) return
	RAID_knownGunIdsLogged = true
	try {
		var entries = RAID_CommonAssetsManagerClass.getInstance().getAllGuns()
		var it = entries.iterator()
		var ids = []
		while (it.hasNext()) {
			ids.push(it.next().getKey().toString())
		}
		global.tfgLog("tfg bandit_roles", `РЕАЛЬНЫЙ список загруженных стволов TACZ (${ids.length} шт.): ${ids.join(', ')}`)
	} catch (e) {
		global.tfgLog("tfg bandit_roles", `Не удалось получить список стволов из CommonAssetsManager: ${e}`)
	}
}

/**
 * Строит ItemStack конкретного ствола через официальный TACZ API
 * (com.tacz.guns.api.item.builder.GunItemBuilder) - это не наша самодеятельность:
 * тот же класс используют GunSmithTable и другая ванильная логика выдачи оружия
 * в самом моде. Сразу с "холостым" боезапасом, без отдельной возни с IGun.
 *
 * gunId теперь ПОЛНЫЙ "namespace:id" (например "create_armorer:smg_auto_crank"),
 * а не голое имя под жёстко зашитым "tacz:" - подтверждено логом
 * (CommonAssetsManager.getAllGuns()), что реальные стволы в этой сборке
 * приходят из ТРЁХ РАЗНЫХ модов (create_armorer, applied_armorer, ulv_guns) и
 * только 4 из vanilla tacz - жёстко приклеенный namespace "tacz" был
 * причиной, почему даже правильно написанное имя ствола не находилось.
 */
function tfgGunStack(gunId) {
	raidLogKnownGunIds()
	var parts = gunId.split(':')
	var namespace = parts.length > 1 ? parts[0] : 'tacz'
	var path = parts.length > 1 ? parts[1] : parts[0]
	return RAID_GunItemBuilderClass.create()
		.setId(new RAID_ResourceLocationClass(namespace, path))
		.setCount(1)
		.setAmmoCount(999)
		.setAmmoInBarrel(true)
		.build()
}

/**
 * ПРОВЕРКА СТВОЛА ПО РЕЕСТРУ ЭТОГО СЕРВЕРА.
 *
 * Роли ссылаются на стволы из четырёх ган-паков: tacz, create_armorer,
 * applied_armorer, ulv_guns. Ган-паки лежат в папке tacz/ у каждой установки
 * свои, и серверная папка собиралась из серверного архива, а не из локальной
 * игры. Если какого-то пака на сервере нет, GunItemBuilder.build() молча
 * отдаёт пустой предмет, и стрелок выходит с пустыми руками.
 *
 * Поэтому id сначала сверяется с CommonAssetsManager.getGunIndex, а при
 * отсутствии берётся замена: базовый TACZ этой сборки по тиру роли, иначе
 * любой реально загруженный ствол.
 */
const RAID_FALLBACK_GUNS = {
	1: ['tacz:db_short', 'tacz:springfield1873'],
	2: ['tacz:springfield1873', 'tacz:db_short'],
	3: ['tacz:m700', 'tacz:db_long'],
	4: ['tacz:m700', 'tacz:db_long'],
	5: ['tacz:m700', 'tacz:db_long'],
}
var RAID_missingGunsLogged = {}

function tfgGunLoaded(gunId) {
	try {
		var parts = String(gunId).split(':')
		var rl = parts.length > 1 ? new RAID_ResourceLocationClass(parts[0], parts[1]) : new RAID_ResourceLocationClass('tacz', parts[0])
		return RAID_CommonAssetsManagerClass.getInstance().getGunIndex(rl) != null
	} catch (e) {
		return false
	}
}

function tfgLoadedGunIds() {
	var ids = []
	try {
		var it = RAID_CommonAssetsManagerClass.getInstance().getAllGuns().iterator()
		while (it.hasNext()) ids.push(String(it.next().getKey()))
	} catch (e) { /* реестр недоступен - пустой список */ }
	return ids
}

/** Нужный ствол, если загружен; иначе замена по тиру; иначе любой загруженный; иначе null. */
function tfgResolveGun(gunId, tier, exclude) {
	if (gunId && gunId !== exclude && tfgGunLoaded(gunId)) return gunId
	var candidates = (RAID_FALLBACK_GUNS[tier] || []).filter(id => id !== exclude && tfgGunLoaded(id))
	if (candidates.length === 0) candidates = tfgLoadedGunIds().filter(id => id !== exclude)
	var pick = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : null
	if (gunId && !RAID_missingGunsLogged[gunId]) {
		RAID_missingGunsLogged[gunId] = true
		global.tfgLog("tfg bandit_roles", "ствола " + gunId + " нет в реестре TACZ этого сервера - замена: " + (pick || "нечем, стволов нет"))
	}
	return pick
}

/** Собрать ствол для роли; если сборка вернула пустоту - одна попытка на замене. */
function tfgBuildGunFor(gunId, tier) {
	var id = tfgResolveGun(gunId, tier, null)
	if (!id) return null
	var stack = tfgGunStack(id)
	if (stack && !stack.isEmpty()) return stack
	var alt = tfgResolveGun(null, tier, id)
	if (!alt) return null
	stack = tfgGunStack(alt)
	return (stack && !stack.isEmpty()) ? stack : null
}

/** Для raids.js: у рейдера ствол, которого нет на сервере, - выдать загруженный. */
global.TFG_REARM_GUNNER = function (entity) {
	try {
		var tier = Number(entity.persistentData.getInt('tfg_bandit_tier')) || 2
		var stack = tfgBuildGunFor(null, tier)
		if (!stack) return false
		entity.setMainHandItem(stack)
		global.tfgLog("tfg bandit_roles", "рейдер " + entity.getType() + " перевооружён: " + stack)
		return true
	} catch (e) {
		global.tfgLog("tfg bandit_roles", "перевооружение не удалось: " + e)
		return false
	}
}

// Базовые мобы primitive_creatures, на которые вешаются роли, сгруппированы по тому,
// в каких пулах пак их и так уже использует (см. template_pool/illagers/*.json) -
// это не даёт слабым лагерям (mob_weak/mob_gatherer) внезапно получить топ-тир снарягу.
const WEAK_BASE = ["primitive_creatures:iloger_1", "primitive_creatures:iloger_2", "primitive_creatures:viloger_10"]
const MEDIUM_BASE = ["primitive_creatures:piloger_9", "primitive_creatures:iloger_4", "primitive_creatures:iloger_5", "primitive_creatures:iloger_6", "primitive_creatures:wiloger"]
// primitive_creatures:iloger_10 ("Берсерк"/Berserker) убран по факту из игры -
// подтверждено на практике: не убивался даже творческим оружием (реген у него,
// судя по всему, врождённый - в самом entity-классе явного MobEffect/Potion
// не нашёл статическим разбором, но пул трогать надёжнее, чем ловить его снова).
const STRONG_BASE = ["primitive_creatures:iloger_3"]

const ALL_BANDIT_ENTITIES = WEAK_BASE.concat(MEDIUM_BASE, STRONG_BASE)

// Отдаём наружу для tfg/raids.js - там та же группировка нужна, чтобы подбирать тир
// рейда под броню игрока, без дублирования этого списка вторым файлом.
global.TFG_BANDIT_WEAK_BASE = WEAK_BASE
global.TFG_BANDIT_MEDIUM_BASE = MEDIUM_BASE
global.TFG_BANDIT_STRONG_BASE = STRONG_BASE

// --- Хелперы сборки экипировки ---

function tfcMelee(kind, tier) {
	return `tfc:metal/${kind}/${tier}`
}

function tfcShield(tier) {
	return `tfc:metal/shield/${tier}`
}

function tfcArmor(tier, pieces) {
	// pieces - какая-то комбинация 'head','chest','legs','feet'; пусто = без брони вообще
	var set = {}
	if (pieces.includes('head')) set.head = `tfc:metal/helmet/${tier}`
	if (pieces.includes('chest')) set.chest = `tfc:metal/chestplate/${tier}`
	if (pieces.includes('legs')) set.legs = `tfc:metal/greaves/${tier}`
	if (pieces.includes('feet')) set.feet = `tfc:metal/boots/${tier}`
	return set
}

const FULL = ['head', 'chest', 'legs', 'feet']

// --- Таблица ролей ---
// tier: 1-5 (условная опасность, используется только для HP/armor-бонуса)
// base: из какой группы мобов может выпасть роль
// mainHand / offHand: строка item id, или null
// gun: true, если mainHand - оружие TACZ (нужно настроить холостой боезапас)
// armorSet: результат tfcArmor(...) или {}
// hp / armorBonus: прибавка к атрибутам (см. events.entities.js - тот же приём modifyAttribute)

const ROLES = [
	// ─── Слабые (WEAK_BASE) ────────────────────────────────────────────────
	{ name: 'tfg_bandit_ragged', tier: 1, weight: 12, base: WEAK_BASE,
		mainHand: tfcMelee('knife', 'copper'), armorSet: {}, hp: 4, armorBonus: 0 },
	{ name: 'tfg_bandit_marauder', tier: 1, weight: 10, base: WEAK_BASE,
		mainHand: tfcMelee('javelin', 'copper'), armorSet: tfcArmor('copper', ['head']), hp: 6, armorBonus: 1 },
	{ name: 'tfg_bandit_clubber', tier: 1, weight: 10, base: WEAK_BASE,
		mainHand: tfcMelee('mace', 'copper'), armorSet: {}, hp: 6, armorBonus: 0 },
	{ name: 'tfg_bandit_poacher', tier: 1, weight: 10, base: WEAK_BASE,
		mainHand: 'ulv_guns:flintlock', gun: true, armorSet: {}, hp: 4, armorBonus: 0 },
	{ name: 'tfg_bandit_tramp_shooter', tier: 1, weight: 9, base: WEAK_BASE,
		mainHand: 'tacz:db_short', gun: true, armorSet: tfcArmor('copper', ['head']), hp: 6, armorBonus: 1 },
	{ name: 'tfg_bandit_axeman_weak', tier: 2, weight: 8, base: WEAK_BASE,
		mainHand: tfcMelee('axe', 'copper'), armorSet: tfcArmor('copper', ['chest']), hp: 8, armorBonus: 1 },
	{ name: 'tfg_bandit_slasher', tier: 1, weight: 9, base: WEAK_BASE,
		mainHand: tfcMelee('knife', 'bismuth_bronze'), armorSet: {}, hp: 8, armorBonus: 0 },
	{ name: 'tfg_bandit_novice_gunner', tier: 2, weight: 7, base: WEAK_BASE,
		mainHand: 'create_armorer:pistol_auto_stress', gun: true, armorSet: tfcArmor('copper', ['feet']), hp: 8, armorBonus: 1 },
	{ name: 'tfg_bandit_spearman_weak', tier: 2, weight: 8, base: WEAK_BASE,
		mainHand: tfcMelee('javelin', 'bismuth_bronze'), armorSet: tfcArmor('bismuth_bronze', ['chest', 'feet']), hp: 10, armorBonus: 2 },
	{ name: 'tfg_bandit_scattergunner', tier: 2, weight: 7, base: WEAK_BASE,
		mainHand: 'create_armorer:shotgun_pump_bearing', gun: true, armorSet: tfcArmor('bismuth_bronze', ['head', 'feet']), hp: 10, armorBonus: 2 },

	// ─── Средние (MEDIUM_BASE) ─────────────────────────────────────────────
	{ name: 'tfg_bandit_cutthroat', tier: 2, weight: 10, base: MEDIUM_BASE,
		mainHand: tfcMelee('sword', 'bronze'), offHand: tfcShield('bronze'), armorSet: tfcArmor('bronze', FULL), hp: 14, armorBonus: 3 },
	{ name: 'tfg_bandit_axeman', tier: 2, weight: 9, base: MEDIUM_BASE,
		mainHand: tfcMelee('axe', 'bronze'), armorSet: tfcArmor('bronze', ['chest', 'legs']), hp: 13, armorBonus: 2 },
	{ name: 'tfg_bandit_musketeer', tier: 2, weight: 9, base: MEDIUM_BASE,
		mainHand: 'tacz:springfield1873', gun: true, armorSet: tfcArmor('black_bronze', ['head', 'chest']), hp: 13, armorBonus: 2 },
	// только для рейдов (base пуст): револьвер Create Armorer - тир игрока 5, чёрная сталь
	{ name: 'tfg_bandit_gunslinger', tier: 3, weight: 8, base: [],
		mainHand: 'create_armorer:pistol_revolver_torque', gun: true, armorSet: tfcArmor('steel', ['head', 'chest']), hp: 16, armorBonus: 3 },
	// стрелки попроще - только рейды (base пуст). Дротики и луки - с первого тира, арбалет - со второго,
	// заводной лук Species - с третьего (minTier: по материалам их тир не посчитать). Стреляют - tfg/raids.js
	{ name: 'tfg_bandit_stone_thrower', tier: 1, weight: 10, base: [],
		mainHand: 'tfc:stone/javelin/igneous_extrusive', ranged: 'javelin', armorSet: {}, hp: 4, armorBonus: 0 },
	{ name: 'tfg_bandit_bowman', tier: 1, weight: 12, base: [],
		mainHand: 'minecraft:bow', ranged: 'bow', armorSet: {}, hp: 4, armorBonus: 0 },
	{ name: 'tfg_bandit_javelineer', tier: 2, weight: 8, base: [],
		mainHand: 'tfc:metal/javelin/bronze', ranged: 'javelin', armorSet: tfcArmor('bronze', ['head']), hp: 8, armorBonus: 1 },
	{ name: 'tfg_bandit_archer', tier: 2, weight: 9, base: [],
		mainHand: 'minecraft:bow', ranged: 'bow', armorSet: tfcArmor('copper', ['head']), hp: 8, armorBonus: 1 },
	{ name: 'tfg_bandit_crossbowman', tier: 2, minTier: 2, weight: 9, base: [],
		mainHand: 'minecraft:crossbow', ranged: 'crossbow', armorSet: tfcArmor('bronze', ['head', 'chest']), hp: 10, armorBonus: 2 },
	{ name: 'tfg_bandit_arbalester', tier: 3, minTier: 3, weight: 8, base: [],
		mainHand: 'minecraft:crossbow', ranged: 'crossbow', armorSet: tfcArmor('wrought_iron', ['head', 'chest']), hp: 14, armorBonus: 3 },
	{ name: 'tfg_bandit_crankbowman', tier: 3, minTier: 3, weight: 8, base: [],
		mainHand: 'species:crankbow', ranged: 'crankbow', armorSet: tfcArmor('wrought_iron', ['head']), hp: 14, armorBonus: 2 },
	{ name: 'tfg_bandit_double_barrel', tier: 3, weight: 8, base: MEDIUM_BASE,
		mainHand: 'tacz:db_long', gun: true, armorSet: tfcArmor('wrought_iron', ['chest']), hp: 15, armorBonus: 2 },
	{ name: 'tfg_bandit_tracker', tier: 3, weight: 8, base: MEDIUM_BASE,
		mainHand: 'create_armorer:rifle_assult_crane', gun: true, armorSet: tfcArmor('wrought_iron', ['head', 'feet']), hp: 15, armorBonus: 2 },
	{ name: 'tfg_bandit_ironclad', tier: 3, weight: 8, base: MEDIUM_BASE,
		mainHand: tfcMelee('sword', 'wrought_iron'), offHand: tfcShield('wrought_iron'), armorSet: tfcArmor('wrought_iron', FULL), hp: 18, armorBonus: 4 },
	{ name: 'tfg_bandit_hammerer', tier: 3, weight: 7, base: MEDIUM_BASE,
		mainHand: tfcMelee('hammer', 'wrought_iron'), armorSet: tfcArmor('wrought_iron', ['chest', 'legs']), hp: 18, armorBonus: 3 },
	{ name: 'tfg_bandit_trooper', tier: 3, weight: 7, base: MEDIUM_BASE,
		mainHand: 'tacz:m700', gun: true, armorSet: tfcArmor('wrought_iron', ['head', 'chest']), hp: 17, armorBonus: 3 },
	{ name: 'tfg_bandit_veteran_spear', tier: 3, weight: 6, base: MEDIUM_BASE,
		mainHand: tfcMelee('javelin', 'steel'), offHand: tfcShield('steel'), armorSet: tfcArmor('steel', FULL), hp: 20, armorBonus: 5 },
	{ name: 'tfg_bandit_steel_butcher', tier: 3, weight: 6, base: MEDIUM_BASE,
		mainHand: tfcMelee('mace', 'steel'), armorSet: tfcArmor('steel', FULL), hp: 21, armorBonus: 5 },
	{ name: 'tfg_bandit_smg_amateur', tier: 3, weight: 6, base: MEDIUM_BASE,
		mainHand: 'create_armorer:smg_auto_crank', gun: true, armorSet: tfcArmor('steel', ['head', 'chest']), hp: 19, armorBonus: 4 },
	{ name: 'tfg_bandit_amateur_sniper', tier: 3, weight: 6, base: MEDIUM_BASE,
		mainHand: 'create_armorer:sniper_semi_clockwork', gun: true, armorSet: tfcArmor('steel', ['head']), hp: 18, armorBonus: 3 },

	// ─── Сильные (STRONG_BASE) ─────────────────────────────────────────────
	{ name: 'tfg_bandit_black_knight', tier: 4, weight: 10, base: STRONG_BASE,
		mainHand: tfcMelee('sword', 'black_steel'), offHand: tfcShield('black_steel'), armorSet: tfcArmor('black_steel', FULL), hp: 30, armorBonus: 7 },
	{ name: 'tfg_bandit_bonecrusher', tier: 4, weight: 9, base: STRONG_BASE,
		mainHand: tfcMelee('mace', 'black_steel'), armorSet: tfcArmor('black_steel', FULL), hp: 32, armorBonus: 7 },
	{ name: 'tfg_bandit_heavy_gunner', tier: 4, weight: 8, base: STRONG_BASE,
		mainHand: 'create_armorer:mg_platemag_flywheel', gun: true, armorSet: tfcArmor('black_steel', ['head', 'chest']), hp: 28, armorBonus: 6 },
	{ name: 'tfg_bandit_grenadier', tier: 4, weight: 6, base: STRONG_BASE,
		mainHand: 'applied_armorer:moritz_gernade_gl3', gun: true, armorSet: tfcArmor('black_steel', ['chest', 'legs']), hp: 27, armorBonus: 6 },
	{ name: 'tfg_bandit_elite_ranger', tier: 4, weight: 8, base: STRONG_BASE,
		mainHand: 'applied_armorer:moritz_rifle_ar77', gun: true, armorSet: tfcArmor('black_steel', FULL), hp: 29, armorBonus: 6 },
	{ name: 'tfg_bandit_smg_veteran', tier: 4, weight: 7, base: STRONG_BASE,
		mainHand: 'applied_armorer:niklas_smg_freedom', gun: true, armorSet: tfcArmor('black_steel', ['head', 'feet']), hp: 27, armorBonus: 5 },
	{ name: 'tfg_bandit_blue_champion', tier: 5, weight: 5, base: STRONG_BASE,
		mainHand: tfcMelee('sword', 'blue_steel'), offHand: tfcShield('blue_steel'), armorSet: tfcArmor('blue_steel', FULL), hp: 42, armorBonus: 9 },
	{ name: 'tfg_bandit_red_berserker', tier: 5, weight: 5, base: STRONG_BASE,
		mainHand: tfcMelee('hammer', 'red_steel'), armorSet: tfcArmor('red_steel', FULL), hp: 45, armorBonus: 9 },
	{ name: 'tfg_bandit_elite_sniper', tier: 5, weight: 4, base: STRONG_BASE,
		mainHand: 'applied_armorer:moritz_sniper_semi_k30', gun: true, armorSet: tfcArmor('blue_steel', ['head', 'chest']), hp: 36, armorBonus: 7 },
	{ name: 'tfg_bandit_assault_commander', tier: 5, weight: 4, base: STRONG_BASE,
		mainHand: 'create_armorer:cannon_40mm_salamander', gun: true, armorSet: tfcArmor('red_steel', FULL), hp: 40, armorBonus: 8 },
]

// быстрый доступ: base entity id -> список подходящих ролей (посчитано один раз при загрузке)
const ROLES_BY_ENTITY = {}
ALL_BANDIT_ENTITIES.forEach(id => { ROLES_BY_ENTITY[id] = [] })
ROLES.forEach(role => {
	role.base.forEach(id => {
		if (ROLES_BY_ENTITY[id]) ROLES_BY_ENTITY[id].push(role)
	})
})

/**
 * То же самое, но по ТИРУ роли, без привязки к мобу - нужно для рейдов.
 *
 * В обычном мире роль подбирается по мобу (ROLES_BY_ENTITY): так слабые лагеря
 * ворлдгена не получают топ-снарягу, и это правильно. Но в рейде состав
 * намеренно смешанный (см. RAID_COMPOSITION в tfg/events.js), и если бы роль
 * по-прежнему выбиралась по мобу, то стволы доставались бы только Костолому
 * (единственному в STRONG_BASE), а все остальные приходили бы с дубьём.
 * Для рейдовых мобов берём роли по тиру самого рейда.
 */
const ROLES_BY_TIER = {}
ROLES.forEach(role => {
	if (!ROLES_BY_TIER[role.tier]) ROLES_BY_TIER[role.tier] = []
	ROLES_BY_TIER[role.tier].push(role)
})

/**
 * Роли для рейдера: основной тир + на ступень ниже, чтобы отряд не выглядел
 * штампованным и в нём попадались бойцы попроще.
 */
function raidRoleCandidates(tier) {
	var list = (ROLES_BY_TIER[tier] || []).slice()
	if (ROLES_BY_TIER[tier - 1]) list = list.concat(ROLES_BY_TIER[tier - 1])
	return list
}

/**
 * С какого тира игрока роль может прийти в рейд: самый высокий тир её вещей (tfg/raid_tiers.js -
 * материалы доспехов и оружия, стволы TACZ по рецептам) или minTier роли, если по материалам не посчитать
 * (луки, арбалеты). Поэтому пулемёты и гранатомёты не приходят к тем, кто не добрался до алюминия, а с
 * рейдера не выпадает то, что игроку ещё недоступно.
 */
var ROLE_MIN_TIER = {}
function roleMinTier(role) {
	if (ROLE_MIN_TIER[role.name] !== undefined) return ROLE_MIN_TIER[role.name]
	var ids = [role.mainHand, role.offHand, role.armorSet.head, role.armorSet.chest, role.armorSet.legs, role.armorSet.feet]
	var t = role.minTier || 1
	ids.forEach(id => {
		if (!id) return
		var v = (role.gun && id === role.mainHand)
			? ((global.TFG_GUN_TIER || {})[id] || 10)                        // неизвестный ствол - только с верхнего тира
			: (global.TFG_ITEM_ID_TIER ? global.TFG_ITEM_ID_TIER(id) : 1)
		if (v > t) t = v
	})
	ROLE_MIN_TIER[role.name] = t
	return t
}

function roleOf(c) { return c.role || c }

/** Роли рейдера по тиру игрока: не выше тира и не ниже чем на 3; выше сложность - чаще верхние роли. */
function raidRolesForPlayerTier(ptier, difficulty) {
	// стволы - на ступень слабее тира игрока (иначе на его тире приходят слишком сильные пушки)
	var list = ROLES.filter(r => roleMinTier(r) <= (r.gun ? ptier - 2 : ptier) && roleMinTier(r) >= ptier - 3)
	if (list.length === 0) list = ROLES.filter(r => roleMinTier(r) <= ptier)
	return list.map(r => {
		var lift = Math.max(0, difficulty - 1) * (roleMinTier(r) - (ptier - 3))
		return { name: r.name, weight: Math.max(0.2, r.weight * (1 + lift)), role: r }
	})
}

// с рейдера не выпадает то, что выше тира игрока (замена ствола, ручной тир и прочие случайности)
function raidClampDrops(entity, ptier) {
	if (!global.TFG_ITEM_TIER) return
	;[SLOT_MAINHAND, SLOT_OFFHAND, SLOT_HEAD, SLOT_CHEST, SLOT_LEGS, SLOT_FEET].forEach(s => {
		try {
			if (global.TFG_ITEM_TIER(entity.getItemBySlot(s)) > ptier) entity.setDropChance(s, 0)
		} catch (e) { }
	})
}

/** Значение тега вида "<prefix><значение>", либо null. */
function raidTagValue(entity, prefix) {
	try {
		var it = entity.getTags().iterator()
		while (it.hasNext()) {
			var t = it.next()
			// String(...) вокруг java.lang.String - чтобы дальше работать с JS-строкой,
			// а не с Java-объектом в обёртке Rhino
			if (t.startsWith(prefix)) return String(t.substring(prefix.length))
		}
	} catch (e) { /* тегов нет - обычный спавн */ }
	return null
}

/** Тир рейда из тега tfg_raid_tier:<n>, либо 0 если моб не рейдовый. */
function raidTierOfEntity(entity) {
	var v = raidTagValue(entity, 'tfg_raid_tier:')
	if (v === null) return 0
	var n = parseInt(v, 10)
	return (n >= 1 && n <= 5) ? n : 0
}

/**
 * СКИНЫ И ВИДИМОЕ ОРУЖИЕ.
 *
 * У мобов primitive_creatures оружие - НЕ предмет в руке. Ни один из 16
 * рендереров мода не рисует ни предмет, ни броню (проверено по всем классам:
 * это GeoEntityRenderer, слои у него только собственные текстурные). Оружие
 * вшито в саму модель: в geo/iloger.geo.json есть кость rightItem на правой
 * руке с плоским кубом 13x8, и он красится обычной текстурой скина.
 *
 * Развёртка этого куба (посчитана из box-uv [0,43] при size [0,13,8]) - две
 * грани по 8x13 в области x 0..16, y 51..64 текстуры 64x64. Из 14 штатных
 * скинов там закрашено у тринадцати (дубины, топоры), а у caveman_8 пусто -
 * это безоружный вариант.
 *
 * Отсюда способ дать разбойнику ВИДИМУЮ винтовку: нарисовать её в этой области
 * и выставить скин через публичный setTexture(name) - поле TEXTURE у моба
 * синхронизируется с клиентом, а модель собирает путь
 * "primitive_creatures:textures/entities/<name>.png".
 *
 * tfg_bandit_gunner_* лежат в kubejs/assets/primitive_creatures/textures/entities/
 * и сделаны перекраской штатных скинов - это ПЛЕЙСХОЛДЕРЫ, не арт.
 *
 * Скин привязан к роли детерминированно: одна и та же роль всегда выглядит
 * одинаково, и по виду можно научиться читать угрозу.
 */
const BANDIT_SKINS_MELEE = [
	'caveman_1', 'caveman_2', 'caveman_3', 'caveman_4', 'caveman_5', 'caveman_6',
	'caveman_7', 'caveman_9', 'caveman_10', 'caveman_11',
	'caveman_93', 'caveman_99', 'caveman_999',
]
const BANDIT_SKINS_GUNNER = [
	'tfg_bandit_gunner_1', 'tfg_bandit_gunner_2',
	'tfg_bandit_gunner_3', 'tfg_bandit_gunner_4',
]

function skinForRole(role) {
	var name = role.name
	var hash = 0
	for (var i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0x7fffffff
	var list = role.gun ? BANDIT_SKINS_GUNNER : BANDIT_SKINS_MELEE
	return list[hash % list.length]
}

/**
 * РЕЙДЕРЫ НА МОДЕЛИ ИГРОКА. Модели primitive_creatures не рисуют предметы в руках (все 16 рендереров -
 * GeoEntityRenderer без слоя предметов), поэтому рейдеры (tfg/raids.js и воздушные рейды) появляются
 * ванильными хасками: модель игрока, видны оружие и броня, на солнце не горят. Тег
 * tfg_bandit_type:<id> хранит, каким бандитом мода рейдер был бы: по нему роль, звуки и добыча
 * (primitive_creatures/loot.js). Скин - по имени через клиентский мод ETF:
 * kubejs/assets/minecraft/optifine/random/entity/zombie/husk.properties (без ETF - обычный хаск).
 * Голос хаска подменяется звуками его бандита мода (ЗВУКИ ХАСКОВ-РЕЙДЕРОВ ниже), стволы звучат как обычно.
 */
const RAID_HUSK = "minecraft:husk"

// звуки бандитов мода по байткоду их классов: [фоновый, удар, смерть]
const RAID_BANDIT_SOUNDS = {
	"primitive_creatures:iloger_1": ["entity.vindicator.ambient", "entity.vindicator.hurt", "entity.vindicator.death"],
	"primitive_creatures:iloger_2": ["entity.pillager.ambient", "entity.pillager.hurt", "entity.pillager.hurt"],
	"primitive_creatures:iloger_3": ["entity.vindicator.ambient", "entity.vindicator.hurt", "entity.vindicator.death"],
	"primitive_creatures:iloger_4": ["entity.pillager.ambient", "entity.pillager.hurt", "entity.pillager.hurt"],
	"primitive_creatures:iloger_5": ["entity.illusioner.ambient", "entity.illusioner.hurt", "entity.illusioner.death"],
	"primitive_creatures:iloger_6": ["entity.evoker.ambient", "entity.evoker.hurt", "entity.evoker.death"],
	"primitive_creatures:piloger_9": ["entity.vindicator.ambient", "entity.vindicator.hurt", "entity.vindicator.death"],
	"primitive_creatures:viloger_10": ["entity.villager.ambient", "entity.villager.hurt", "entity.villager.death"],
}

// имя = скин в ETF: рукопашные по тиру, стрелки - младшие и старшие
function raidSkinName(role) {
	if (role.gun || role.ranged) return role.tier >= 4 ? "Наёмник" : "Стрелок"
	if (role.tier >= 4) return "Головорез"
	if (role.tier === 3) return "Громила"
	return "Разбойник"
}

var RAID_HUSKS = {}   // uuid -> { e, sounds }

/**
 * ЗВУКИ ХАСКОВ-РЕЙДЕРОВ. Раньше хаск был Silent, а звуки бандита игрались командой. Но TACZ играет выстрел
 * моба звуком, привязанным к стрелку (GunSoundInstance extends EntityBoundSoundInstance), а такой звук у
 * Silent-сущности клиент не играет - стволы рейдеров стреляли беззвучно. Теперь хаск не молчит, а голос
 * подменяется на лету: Forge-событие PlayLevelSoundEvent.AtPosition - в точке звука хаска ищем рейдера из
 * RAID_HUSKS; рычание, удар и смерть меняем на звуки его бандита мода, шаги зомби - на шаги по блоку под
 * ногами, как у игрока.
 * ForgeEvents в серверных скриптах нет, поэтому слушатель вешается прямо на шину Forge - один раз за запуск
 * сервера (иначе каждый /reload добавлял бы копию), а работу делает global.TFG_RAIDER_SOUND, которую
 * обновляет каждая загрузка скриптов.
 */
const BR_SOUND_HOSTILE = Java.loadClass("net.minecraft.sounds.SoundSource").HOSTILE.ordinal()
const BR_ForgeRegistries = Java.loadClass("net.minecraftforge.registries.ForgeRegistries")
const BR_BuiltInRegistries = Java.loadClass("net.minecraft.core.registries.BuiltInRegistries")
// Имя своё: прежнее BR_BlockPos уже объявлено в factions/bridges.js, а у KubeJS все файлы
// в одном пространстве имён - из-за повтора ЭТОТ ФАЙЛ ЦЕЛИКОМ не загружался
// («redeclaration of const BR_BlockPos» в журнале сервера), и роли бандитов не работали.
const BRL_BlockPos = Java.loadClass("net.minecraft.core.BlockPos")
const BR_HUSK_VOICE = {
	"minecraft:entity.husk.ambient": 0, "minecraft:entity.husk.hurt": 1, "minecraft:entity.husk.death": 2,
	"minecraft:entity.husk.step": 3, "minecraft:entity.husk.converted_to_zombie": 4,
}
var BR_soundHolders = {}

function brSoundHolder(id) {
	if (BR_soundHolders[id] === undefined) {
		var h = null
		try { h = BR_ForgeRegistries.SOUND_EVENTS.getHolder(new RAID_ResourceLocationClass(id)).orElse(null) } catch (e) { }
		BR_soundHolders[id] = h
	}
	return BR_soundHolders[id]
}

function brHuskAt(pos) {
	var x = pos.x()
	var y = pos.y()
	var z = pos.z()
	for (var id in RAID_HUSKS) {
		var e = RAID_HUSKS[id].e
		if (Math.abs(e.getX() - x) < 0.01 && Math.abs(e.getZ() - z) < 0.01 && Math.abs(e.getY() - y) < 0.01) return RAID_HUSKS[id]
	}
	return null
}

global.TFG_RAIDER_SOUND = event => {
	if (event.getSource().ordinal() !== BR_SOUND_HOSTILE || event.getLevel().isClientSide()) return
	var kind = BR_HUSK_VOICE[String(event.getSound().value().getLocation())]
	if (kind === undefined) return
	var husk = brHuskAt(event.getPosition())
	if (!husk) return
	if (kind === 3) {
		var p = event.getPosition()
		var below = event.getLevel().getBlockState(BRL_BlockPos.containing(p.x(), p.y() - 0.2, p.z()))
		event.setSound(BR_BuiltInRegistries.SOUND_EVENT.wrapAsHolder(below.getSoundType().getStepSound()))
		return
	}
	var h = kind < 3 && husk.sounds ? brSoundHolder("minecraft:" + husk.sounds[kind]) : null
	if (h) event.setSound(h)
	else event.setCanceled(true)
}

if (!global.TFG_RAIDER_SOUND_HOOK) {
	try {
		Java.loadClass("net.minecraftforge.common.MinecraftForge").EVENT_BUS.addListener(
			Java.loadClass("net.minecraftforge.eventbus.api.EventPriority").NORMAL, false,
			Java.loadClass("net.minecraftforge.event.PlayLevelSoundEvent$AtPosition"),
			event => {
				try {
					if (global.TFG_RAIDER_SOUND) global.TFG_RAIDER_SOUND(event)
				} catch (err) { }
			})
		global.TFG_RAIDER_SOUND_HOOK = true
		global.tfgLog("tfg bandit_roles", "звуки рейдеров: слушатель PlayLevelSoundEvent повешен")
	} catch (e) {
		global.tfgLogError("tfg bandit_roles", "звуки рейдеров: слушатель не повесился - хаски будут звучать как хаски", e)
	}
}

/**
 * ОДЕЖДА РЕЙДЕРОВ. Пустые слоты брони - комплект из tfc_textile / TFC Ambiental по тиру игрока (металлические
 * части роли остаются на месте). У каждой вещи шанс выпасть RAID_CLOTHING_DROP.
 */
const RAID_CLOTHING_DROP = 0.2
function brTextile(name) {
	return ["tfc_textile:" + name + "_hat", "tfc_textile:" + name + "_shirt", "tfc_textile:" + name + "_pants", "tfc_textile:" + name + "_boots"]
}
function brAmbiental(head, chest, legs, feet) {
	return ["tfcambiental:" + head, "tfcambiental:" + chest, "tfcambiental:" + legs, "tfcambiental:" + feet]
}
const RAID_CLOTHES = [
	{ from: 1, to: 3, weight: 10, set: ["tfc_textile:raw_hat", "tfc_textile:raw_shirt", "tfc_textile:raw_pants", "tfc_textile:raw_socks"] },
	{ from: 1, to: 4, weight: 8, set: brAmbiental("burlap_cowl", "burlap_shirt", "burlap_pants", "burlap_shoes") },
	{ from: 2, to: 5, weight: 7, set: ["tfc_textile:linen_hat", "tfc_textile:linen_shirt", "tfc_textile:linen_pants", "tfc_textile:linen_socks"] },
	{ from: 2, to: 6, weight: 4, set: brTextile("caribou") },
	{ from: 2, to: 6, weight: 4, set: brTextile("crocodile") },
	{ from: 3, to: 7, weight: 6, set: brAmbiental("wool_hat", "wool_sweater", "wool_pants", "wool_boots") },
	{ from: 3, to: 8, weight: 6, set: ["tfc_textile:cotton_hat", "tfc_textile:cotton_shirt", "tfc_textile:cotton_pants", "tfc_textile:cotton_socks"] },
	{ from: 3, to: 10, weight: 3, set: brTextile("direwolf") },
	{ from: 3, to: 10, weight: 3, set: brTextile("cougar") },
	{ from: 4, to: 10, weight: 3, set: brTextile("black_bear") },
	{ from: 4, to: 10, weight: 6, set: brAmbiental("insulated_leather_hat", "insulated_leather_tunic", "insulated_leather_pants", "insulated_leather_boots") },
	{ from: 5, to: 10, weight: 3, set: brTextile("grizzly_bear") },
	{ from: 5, to: 10, weight: 2, set: brTextile("polar_bear") },
	{ from: 5, to: 10, weight: 3, set: brTextile("panther") },
	{ from: 6, to: 10, weight: 2, set: brTextile("lion") },
	{ from: 6, to: 10, weight: 2, set: brTextile("tiger") },
	{ from: 6, to: 10, weight: 2, set: brTextile("sabertooth") },
	{ from: 6, to: 10, weight: 4, set: brAmbiental("silk_cowl", "silk_shirt", "silk_pants", "silk_shoes") },
]

function raidDress(entity, tier) {
	var list = RAID_CLOTHES.filter(c => tier >= c.from && tier <= c.to)
	if (list.length === 0) return
	var set = pickWeighted(list).set
	var slots = [SLOT_HEAD, SLOT_CHEST, SLOT_LEGS, SLOT_FEET]
	for (var i = 0; i < slots.length; i++) {
		try {
			if (!entity.getItemBySlot(slots[i]).isEmpty()) continue
			entity.setItemSlot(slots[i], Item.of(set[i]))
			entity.setDropChance(slots[i], RAID_CLOTHING_DROP)
		} catch (e) { }
	}
}

// хаск-рейдер: имя под скин, голос бандита вместо рычания, без подбора вещей и без подкреплений зомби
function setupRaidHusk(entity, role, origType) {
	entity.setCustomName(Text.of(raidSkinName(role)))
	entity.setCustomNameVisible(false)
	entity.setSilent(false)   // Silent глушит и выстрелы TACZ - см. ЗВУКИ ХАСКОВ-РЕЙДЕРОВ
	entity.setCanPickUpLoot(false)
	try { entity.setBaby(false) } catch (e) { }
	try { entity.setAttributeBaseValue("minecraft:zombie.spawn_reinforcements", 0) } catch (e) { }
	RAID_HUSKS[String(entity.uuid)] = { e: entity, sounds: RAID_BANDIT_SOUNDS[origType] || null }
}

function pickWeighted(list) {
	var total = 0
	for (var i = 0; i < list.length; i++) total += list[i].weight
	var roll = Math.random() * total
	for (var j = 0; j < list.length; j++) {
		roll -= list[j].weight
		if (roll <= 0) return list[j]
	}
	return list[list.length - 1]
}

function giveArmorPiece(entity, slot, id) {
	if (!id) return
	if (slot === SLOT_HEAD) entity.setHeadArmorItem(Item.of(id))
	else if (slot === SLOT_CHEST) entity.setChestArmorItem(Item.of(id))
	else if (slot === SLOT_LEGS) entity.setLegsArmorItem(Item.of(id))
	else if (slot === SLOT_FEET) entity.setFeetArmorItem(Item.of(id))
	entity.setDropChance(slot, 0.05) // 5% - не завал лута с топ-тир вещей, но не пусто
}

function equipBandit(entity, role) {
	// скин под роль - только у мобов мода, у ванильных setTexture нет
	if (typeof entity.setTexture === 'function') {
		try {
			entity.setTexture(skinForRole(role))
		} catch (e) {
			global.tfgLog("tfg bandit_roles", `не удалось поставить скин для ${role.name}: ${e}`)
		}
	}

	if (role.mainHand) {
		var mainStack
		if (role.gun) {
			// tfgGunStack (см. выше) - официальный com.tacz.guns.api.item.builder.GunItemBuilder,
			// сразу с холостым боезапасом и патроном в стволе.
			//
			// ВАЖНО (нашёл байткодом): GunItemBuilder.build() при неудачном поиске id в
			// TimelessAPI.getCommonGunIndex(...) НЕ кидает исключение - молча возвращает
			// ItemStack.EMPTY. Раньше это было абсолютно не видно (наш try/catch на
			// исключение просто ни разу не срабатывал, а на "тихий воздух" - и подавно).
			// Все 12 ган-id перепроверены по assets/tacz/lang/en_us.json из самого
			// ганпака (tacz.gun.<id>.name) - все существуют, это не опечатка в id.
			// Логируем явно и факт выбора роли, и итоговое isEmpty() - следующий тест
			// покажет однозначно, доходит ли дело до пустого предмета или роль вообще
			// не выпадает.
			global.tfgLog("tfg bandit_roles", `роль ${role.name}: собираю ствол ${role.mainHand}`)
			try {
				// tfgBuildGunFor сверяет id с реестром TACZ этого сервера и при
				// отсутствии ган-пака подбирает загруженную замену того же тира
				mainStack = tfgBuildGunFor(role.mainHand, role.tier)
				if (!mainStack) {
					global.tfgLog("tfg bandit_roles", "[ПУСТО] не удалось собрать ни " + role.mainHand + ", ни замену - реестр стволов TACZ пуст?")
				} else {
					global.tfgLog("tfg bandit_roles", "ствол для " + role.name + " собран: " + mainStack)
				}
			} catch (e) {
				global.tfgLog("tfg bandit_roles", "Не удалось собрать ствол " + role.mainHand + ": " + e)
				mainStack = null
			}
		} else {
			mainStack = Item.of(role.mainHand)
		}
		if (mainStack && !mainStack.isEmpty()) {
			entity.setMainHandItem(mainStack)
			entity.setDropChance(SLOT_MAINHAND, 0.08)
		}
	}
	if (role.offHand) {
		entity.setOffHandItem(Item.of(role.offHand))
		entity.setDropChance(SLOT_OFFHAND, 0.05)
	}
	giveArmorPiece(entity, SLOT_HEAD, role.armorSet.head)
	giveArmorPiece(entity, SLOT_CHEST, role.armorSet.chest)
	giveArmorPiece(entity, SLOT_LEGS, role.armorSet.legs)
	giveArmorPiece(entity, SLOT_FEET, role.armorSet.feet)

	if (role.hp) {
		var missingHealth = role.hp
		entity.modifyAttribute("minecraft:generic.max_health", "tfg_bandit_hp_" + role.name, missingHealth, "addition")
		entity.health += missingHealth
	}
	if (role.armorBonus) {
		entity.modifyAttribute("minecraft:generic.armor", "tfg_bandit_armor_" + role.name, role.armorBonus, "addition")
	}

	entity.persistentData.putString("tfg_bandit_role", role.name)
	entity.persistentData.putInt("tfg_bandit_tier", role.tier)
}

EntityEvents.spawned(event => {
	var entity = event.entity
	var type = entity.type

	// рейдер экипируется по тиру рейда, обычный моб - по своей группе.
	// Рейдовые мобы пропускаются даже если это не разбойник мода: стрелками у нас
	// работают ванильные пиллаждеры - только у них виден ствол в руке.
	var raidTier = raidTierOfEntity(entity)
	// рейдер на модели игрока: хаск с тегом типа бандита мода
	var origType = type === RAID_HUSK ? raidTagValue(entity, 'tfg_bandit_type:') : null
	if (origType) type = origType
	if (!ALL_BANDIT_ENTITIES.includes(type)) return
	if (entity.persistentData.contains("tfg_bandit_role")) {
		// уже экипирован (чанк перезагрузился); хаска вернуть в список звуков - имя и флаги хранит сам моб
		if (origType) {
			RAID_HUSKS[String(entity.uuid)] = { e: entity, sounds: RAID_BANDIT_SOUNDS[origType] || null }
			entity.setSilent(false)
			if (typeof raidSetupAi === 'function') raidSetupAi(entity)
		}
		return
	}

	// рейд по новой системе: роли по тиру игрока (tfg_raid_ptier) и сложности (tfg_raid_diff, x100)
	var ptierTag = raidTagValue(entity, 'tfg_raid_ptier:')
	var ptier = ptierTag !== null ? Math.max(1, parseInt(ptierTag, 10) || 1) : 0
	var diffTag = raidTagValue(entity, 'tfg_raid_diff:')
	var difficulty = diffTag !== null ? (parseInt(diffTag, 10) || 100) / 100 : 1
	var candidates = ptier > 0 ? raidRolesForPlayerTier(ptier, difficulty)
		: (raidTier > 0 ? raidRoleCandidates(raidTier) : ROLES_BY_ENTITY[type])
	if (!candidates || candidates.length === 0) return

	// стрелок должен получить роль со стволом, рукопашник - без
	var kind = raidTagValue(entity, 'tfg_raid_kind:')
	if (kind === 'gunner') {
		var gunsNow = tfgGunsAvailable()
		var shooters = candidates.filter(r => !!roleOf(r).ranged || (!!roleOf(r).gun && gunsNow))
		if (shooters.length > 0) candidates = shooters
	} else if (kind === 'melee') {
		var meleeRoles = candidates.filter(r => !roleOf(r).gun && !roleOf(r).ranged)
		// верхние тиры: рукопашных ролей в окне тира нет - берём самые сильные из доступных
		if (meleeRoles.length === 0 && ptier > 0) {
			var allMelee = ROLES.filter(r => !r.gun && !r.ranged && roleMinTier(r) <= ptier)
			var topMelee = Math.max.apply(null, allMelee.map(r => roleMinTier(r)))
			meleeRoles = allMelee.filter(r => roleMinTier(r) === topMelee)
		}
		if (meleeRoles.length > 0) candidates = meleeRoles
	}

	var role = roleOf(pickWeighted(candidates))

	/**
	 * Реестр стволов TACZ пуст, пока идёт /reload (в этом паке это ~2.5 минуты).
	 * Проверено логом: в 17:31 CommonAssetsManager.getAllGuns() отдавал 21 ствол и
	 * всё собиралось, а в 18:29 - ровно во время перезагрузки - ноль, и
	 * GunItemBuilder.build() молча вернул пустой предмет. Разбойник в итоге выходил
	 * с пустыми руками и дрался кулаками, что и выглядело как "огнестрела нет".
	 *
	 * Ждать реестра нельзя (моб уже спавнится), поэтому если стволов сейчас нет -
	 * честно берём ближнебойную роль того же тира: рейдер будет вооружён хоть чем-то.
	 */
	if (role.gun && !tfgGunsAvailable()) {
		var melee = candidates.filter(r => !roleOf(r).gun)
		if (melee.length > 0) {
			var fallback = roleOf(pickWeighted(melee))
			global.tfgLog("tfg bandit_roles", `реестр стволов TACZ сейчас пуст (идёт /reload?) - роль "${role.name}" заменена на ближнебойную "${fallback.name}"`)
			role = fallback
		}
	}

	global.tfgLog("tfg bandit_roles", `${type} -> роль "${role.name}" (тир ${role.tier}, ${candidates.length} кандидатов в пуле, gun=${!!role.gun}${raidTier > 0 ? `, рейд тира ${raidTier}` : ''})`)
	equipBandit(entity, role)
	if (origType) {
		setupRaidHusk(entity, role, origType)
		raidDress(entity, ptier > 0 ? ptier : role.tier)
		if (typeof raidSetupAi === 'function') raidSetupAi(entity)
	}
	if (ptier > 0) raidClampDrops(entity, ptier)

	if (raidTier > 0) {
		try {
			// multiply_total ложится ПОВЕРХ бонуса роли, поэтому один множитель на всё
			entity.modifyAttribute("minecraft:generic.max_health", "tfg_raid_frail", RAID_MEMBER_HEALTH_MULT - 1, "multiply_total")
			entity.health = Math.min(entity.health, entity.maxHealth)
		} catch (e) {
			global.tfgLog("tfg bandit_roles", "не удалось ослабить рейдера: " + e)
		}
	}
})

// список хасков-рейдеров для подмены звуков: погибших и выгруженных убираем (звук смерти играет раньше события)
EntityEvents.death(event => {
	var e = event.entity
	if (e.type !== RAID_HUSK) return
	delete RAID_HUSKS[String(e.uuid)]
})

ServerEvents.tick(event => {
	if (event.server.tickCount % 200 !== 0) return
	for (var id in RAID_HUSKS) {
		try {
			if (!RAID_HUSKS[id].e.isAlive()) delete RAID_HUSKS[id]
		} catch (err) {
			delete RAID_HUSKS[id]
		}
	}
})

// ---- оружие рейдеров при гибели ---------------------------------------------------------------
// Ствол выпадает (если выпал) без патронов - у рейдеров магазин на 999, - а рядом всегда падает
// пачка патронов к нему. С лучника и арбалетчика - несколько стрел.
const BR_IGun = Java.loadClass("com.tacz.guns.api.item.IGun")
const BR_TimelessAPI = Java.loadClass("com.tacz.guns.api.TimelessAPI")
const BR_AmmoBuilder = Java.loadClass("com.tacz.guns.api.item.builder.AmmoItemBuilder")
const BR_ARROW_WEAPONS = { "minecraft:bow": true, "minecraft:crossbow": true, "species:crankbow": true }

function brDropItem(e, id, count, nbt) {
	e.getServer().runCommandSilent("execute in " + String(e.level.getDimension()) + " run summon minecraft:item " +
		e.getX() + " " + (e.getY() + 0.5) + " " + e.getZ() + ' {Item:{id:"' + id + '",Count:' + count + 'b' + (nbt ? ',tag:' + nbt : '') + '}}')
}

EntityEvents.death(event => {
	var e = event.entity
	try {
		var tags = e.getTags()
		if (!tags.contains("tfg_raid") && !tags.contains("tfg_air_crew")) return
		var stack = e.getMainHandItem()
		if (BR_ARROW_WEAPONS[String(stack.id)]) {
			brDropItem(e, "minecraft:arrow", 2 + Math.floor(Math.random() * 5), null)
			return
		}
		var gun = BR_IGun.getIGunOrNull(stack)
		if (!gun) return
		var gunId = gun.getGunId(stack)
		gun.setCurrentAmmoCount(stack, 0)
		gun.setBulletInBarrel(stack, false)
		var index = BR_TimelessAPI.getCommonGunIndex(gunId)
		if (!index.isPresent()) return
		var data = index.get().getGunData()
		var ammo = BR_AmmoBuilder.create().setId(data.getAmmoId()).setCount(1).build()
		var count = Math.min(Number(ammo.getMaxStackSize()), Math.max(6, Math.min(64, Number(data.getAmmoAmount()))))
		brDropItem(e, String(ammo.id), count, ammo.getNbt())
	} catch (err) {
		global.tfgLog("tfg bandit_roles", "добыча оружия с рейдера " + e + ": " + err)
	}
})

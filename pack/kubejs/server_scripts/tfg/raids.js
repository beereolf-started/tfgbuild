// priority: 0
"use strict";

/**
 * СИСТЕМА РЕЙДОВ РАЗБОЙНИКОВ - самостоятельный модуль.
 *
 * Раньше этот код жил внутри tfg/events.js. Вынесен обратно в отдельный файл,
 * чтобы механику можно было отдавать целиком, не таща с собой чужой код пака.
 * Проверено: рейдовая часть и остальное содержимое events.js друг от друга не
 * зависят вообще (ни одной общей функции или переменной).
 *
 * Ничего подключать в main_server_script.js не нужно - файл сам вешает свои
 * ServerEvents.tick / EntityEvents.spawned / ServerEvents.commandRegistry.
 *
 * Пара: server_scripts/primitive_creatures/bandit_roles.js - роли, экипировка,
 * скины. Без него рейд заспавнит мобов, но без снаряжения.
 */

// ============================================================================
// Рейды разбойников (primitive_creatures, экипированные в bandit_roles.js).
// Перенесено сюда из отдельного файла tfg/raids.js: тот файл на диске
// существовал и был валиден, но KubeJS его не грузил ни разу ни в одной
// сессии - по логу видно, что он пропадал в точке перехода между сегментами
// обхода директорий (тот же паттерн, что и у уже существовавшего в паке
// tfg/ores_and_materials/events.stone_hammer_mining.js - тоже не мой файл,
// тоже иногда пропадает). Раз баг в обходе, а не в содержимом - надёжнее
// держать этот код внутри уже стабильно грузящегося файла, чем гадать,
// какое имя/расположение файла обойдёт баг.
//
// - Раз в игровой день (TFC-календарь) для каждого игрока бросается кубик так, чтобы
//   в среднем получалось ~2 рейда в месяц (p = 2 / daysInMonth); минимум RAID_MIN_DAYS_BETWEEN
//   дней между рейдами одному игроку, чтобы не было двух подряд.
// - Тир рейда = средний тир надетой на игрока TFC-брони (медь=1 ... сине/красная сталь=5),
//   это определяет, из какого пула primitive_creatures (WEAK/MEDIUM/STRONG - те же группы,
//   что и в bandit_roles.js) берутся рейдеры; экипировку/роль каждому уже назначает
//   ОБЫЧНЫЙ хук bandit_roles.js - он ловит EntityEvents.spawned независимо от того, кто
//   заспавнил моба (мы через /summon, как и wave_spawns.js), так что вторую копию таблицы
//   ролей заводить не пришлось - только достали общие списки баз через global.*.
// - Группа 3-5 рейдеров спавнится в 32-64 блоках от игрока (execute at <player> run summon,
//   тот же приём, что в wave_spawns.js), помечается тегом tfg_raid_id:<id>.
// - ИИ (без кастомного Java Goal - средствами kubejs): раз в RAID_AI_INTERVAL_TICKS для
//   каждого живого рейдера - если видит игрока (hasLineOfSight) в пределах RAID_VISION_RANGE
//   (специально расширено за обычную дальность обнаружения моба - "рейд всё-таки"),
//   принудительно entity.setTarget(player), дальше бой ведёт штатный ИИ моба (+ TACZ,
//   если в руках ствол). Если не видит - идёт к заранее найденному укрытию
//   (findShelter: крыша/отсутствие неба над головой + кровать/mcw-мебель/источник света)
//   через entity.getNavigation().moveTo(...), с периодическим переприказом, чтобы не
//   спамить пересчёт пути. Это приближение, не полноценный Goal - на очень пересечённой
//   местности возможны потери маршрута, но в среднем должно работать на дистанции "пара
//   чанков", о которой вы просили.
// ============================================================================

const CalendarsClass = Java.loadClass("net.dries007.tfc.util.calendar.Calendars")
const RAID_BlockPosClass = Java.loadClass("net.minecraft.core.BlockPos")
const BlockTagsClass = Java.loadClass("net.minecraft.tags.BlockTags")
const RAID_ForgeRegistriesClass = Java.loadClass("net.minecraftforge.registries.ForgeRegistries")
const RAID_HeightmapTypesClass = Java.loadClass("net.minecraft.world.level.levelgen.Heightmap$Types")
const RAID_MOTION_BLOCKING = RAID_HeightmapTypesClass.MOTION_BLOCKING
const RAID_TagKeyClass = Java.loadClass("net.minecraft.tags.TagKey")

/**
 * СТРЕЛЬБА РЕЙДЕРОВ ИЗ TACZ-СТВОЛОВ.
 *
 * Разобрано по байткоду, почему без этого блока они дрались только в упор:
 *  - у моба primitive_creatures (класс Pilarre2Entity) в registerGoals ЕДИНСТВЕННАЯ
 *    боевая цель - анонимный наследник MeleeAttackGoal. Ни дальнобойной цели, ни
 *    чего-либо про оружие там нет вообще;
 *  - сам TACZ никакого ИИ для мобов не поставляет (в jar нет ни одного Goal), а
 *    taczjs даёт только клиентские хелперы. Стрельбу инициирует игрок вводом.
 * То есть ствол в руке моба - просто предмет: держать может, применить нечем.
 *
 * Официальный путь выстрелить за произвольного LivingEntity - IGunOperator
 * (com.tacz.guns.api.entity.IGunOperator, миксин висит на самом LivingEntity).
 * ВАЖНО: первым делом нужен draw(...) - в LivingEntityShoot.shoot() первая же
 * строка возвращает ShootResult.NOT_DRAW, если data.currentGunItem == null.
 * Поэтому ствол сначала "достают", один раз, и только потом стреляют.
 */
const RAID_IGunOperatorClass = Java.loadClass("com.tacz.guns.api.entity.IGunOperator")
const RAID_IGunClass = Java.loadClass("com.tacz.guns.api.item.IGun")
const RAID_FloatClass = Java.loadClass("java.lang.Float")

// Math.PI в этом Rhino на практике оказался NaN (см. комментарий в spawnRaid) -
// держим значение литералом, чтобы углы не превращались в NaN.
const RAID_PI = 3.141592653589793
const RAID_SHOOT_MIN_DIST = 5      // ближе - пусть работает штатный ближний бой
const RAID_SHOOT_MAX_DIST = 48     // дальше не стреляем, чтобы не палили в никуда
const RAID_Vec3Class = Java.loadClass("net.minecraft.world.phys.Vec3")
const RAID_AABBClass = Java.loadClass("net.minecraft.world.phys.AABB")
const RAID_ClipContextClass = Java.loadClass("net.minecraft.world.level.ClipContext")
const RAID_ClipBlockClass = Java.loadClass("net.minecraft.world.level.ClipContext$Block")
const RAID_ClipFluidClass = Java.loadClass("net.minecraft.world.level.ClipContext$Fluid")
const RAID_HIT_MISS = Java.loadClass("net.minecraft.world.phys.HitResult$Type").MISS.ordinal()
const RAID_ArrowClass = Java.loadClass("net.minecraft.world.entity.projectile.Arrow")
const RAID_JavelinClass = Java.loadClass("net.dries007.tfc.common.entities.misc.ThrownJavelin")
const RAID_MAIN_HAND = Java.loadClass("net.minecraft.world.InteractionHand").MAIN_HAND
const RAID_ZombieAttackGoalClass = Java.loadClass("net.minecraft.world.entity.ai.goal.ZombieAttackGoal")
const RAID_RandomStrollGoalClass = Java.loadClass("net.minecraft.world.entity.ai.goal.RandomStrollGoal")
const RAID_MoveThroughVillageGoalClass = Java.loadClass("net.minecraft.world.entity.ai.goal.MoveThroughVillageGoal")

/**
 * Союзник на линии огня. Стрелок на дирижабле убивал своего пилота, пешие - друг друга:
 * пуля TACZ бьёт первого на пути. Не стреляем, если между глазами стрелка и глазами цели
 * есть бандит (primitive_creatures) или аппарат (immersive_aircraft). Аппарат, в котором
 * сидит сам стрелок, не считается: линия начинается внутри его коробки.
 */
function raidAllyInLine(shooter, target) {
	var sx = shooter.getX()
	var sy = shooter.getEyeY()
	var sz = shooter.getZ()
	var tx = target.getX()
	var ty = target.getEyeY()
	var tz = target.getZ()
	var from = new RAID_Vec3Class(sx, sy, sz)
	var to = new RAID_Vec3Class(tx, ty, tz)
	var box = new RAID_AABBClass(Math.min(sx, tx), Math.min(sy, ty), Math.min(sz, tz), Math.max(sx, tx), Math.max(sy, ty), Math.max(sz, tz)).inflate(1)
	var skip = [String(shooter.uuid), String(target.uuid)]
	var own = shooter.getVehicle()
	if (own) skip.push(String(own.uuid))
	var list = shooter.level.getEntities(shooter, box)
	for (var i = 0; i < list.size(); i++) {
		var e = list.get(i)
		if (skip.indexOf(String(e.uuid)) >= 0) continue
		var type = String(e.type)
		if (type.indexOf("primitive_creatures:") !== 0 && type.indexOf("immersive_aircraft:") !== 0 && !e.getTags().contains("tfg_bandit")) continue
		if (e.getBoundingBox().inflate(0.3).clip(from, to).isPresent()) return true
	}
	return false
}

function raidHoldsGun(entity) {
	try {
		return RAID_IGunClass.getIGunOrNull(entity.getMainHandItem()) !== null
	} catch (e) {
		return false
	}
}

/**
 * Состояние "ствол достан" хранится ТОЛЬКО в памяти скрипта.
 *
 * Раньше флаг tfg_raid_gun_drawn писался в persistentData моба, а она
 * сохраняется на диск вместе с сущностью. Само же состояние TACZ (какой ствол
 * "в руках" у оператора) не сохраняется: в миксине LivingEntityMixin нет ни
 * save, ни load. После выгрузки чанка или рестарта сервера флаг говорил
 * "достал", TACZ говорил "нет", и shoot() навсегда отвечал NOT_DRAW: ствол в
 * руках, выстрелов ноль. В одиночной игре рейд обычно не переживал
 * перезагрузку - поэтому там всё и работало.
 *
 * Теперь исход каждого выстрела разбирается: NOT_DRAW - достаём заново,
 * NO_AMMO - пополняем магазин, ID_NOT_EXIST - такого ствола нет на этом
 * сервере, перевооружаем загруженным (global.TFG_REARM_GUNNER в bandit_roles.js).
 */
var RAID_GUN_STATE = {} // uuid -> { drawn, last }

function raidGunKey(entity) {
	var u = entity.uuid
	return u ? String(u) : String(entity)
}

function raidDraw(entity, st) {
	try {
		RAID_IGunOperatorClass.fromLivingEntity(entity).draw(() => entity.getMainHandItem())
		st.drawn = true
		return true
	} catch (e) {
		raidErr("стрельба: не удалось достать ствол у " + entity, e)
		return false
	}
}

/** Полный магазин и патрон в стволе: инвентаря с патронами у рейдера нет. */
function raidRefillAmmo(entity) {
	try {
		var stack = entity.getMainHandItem()
		var gun = RAID_IGunClass.getIGunOrNull(stack)
		if (!gun) return false
		gun.setCurrentAmmoCount(stack, 999)
		gun.setBulletInBarrel(stack, true)
		return true
	} catch (e) {
		raidErr("стрельба: не удалось пополнить патроны у " + entity, e)
		return false
	}
}

/** java.lang.Float через строку: Float.valueOf(<JS-число>) ушло бы в valueOf(float)/valueOf(String) наугад. */
function raidFloat(n) {
	return RAID_FloatClass.valueOf(String(n))
}

/** Штатные паузы между выстрелами: просто ждём следующего тика ИИ. */
const RAID_SHOOT_WAIT = { IS_DRAWING: true, COOL_DOWN: true, IS_BOLTING: true, IS_RELOADING: true, IS_SPRINTING: true, OVERHEATED: true, IS_MELEE: true }

function raidTryShoot(entity, player, distSq) {
	if (distSq < RAID_SHOOT_MIN_DIST * RAID_SHOOT_MIN_DIST) return false
	if (distSq > RAID_SHOOT_MAX_DIST * RAID_SHOOT_MAX_DIST) return false
	if (!raidHoldsGun(entity)) return false

	var key = raidGunKey(entity)
	var st = RAID_GUN_STATE[key]
	if (!st) {
		st = { drawn: false, last: '' }
		RAID_GUN_STATE[key] = st
	}
	if (!st.drawn) {
		raidDraw(entity, st)
		return false // доставание занимает время - стреляем со следующих тиков
	}

	// союзник на линии огня - ждём; если проверка сломалась, тоже не стреляем (и пишем об этом раз)
	var allyBlocks = true
	try {
		allyBlocks = raidAllyInLine(entity, player)
	} catch (e) {
		if (!st.allyErr) {
			st.allyErr = true
			raidErr("стрельба: проверка союзников на линии огня не сработала - не стреляем", e)
		}
	}
	if (allyBlocks) {
		if (!st.allyLogged) {
			st.allyLogged = true
			raidLog("стрельба: " + entity.getType() + " придержал огонь - на линии союзник")
		}
		return false
	}

	try {
		// углы на цель: yaw/pitch в градусах, как их понимает Minecraft
		var dx = player.getX() - entity.getX()
		var dy = (player.getY() + player.getEyeHeight()) - (entity.getY() + entity.getEyeHeight())
		var dz = player.getZ() - entity.getZ()
		var horiz = Math.sqrt(dx * dx + dz * dz)
		var yaw = Math.atan2(dz, dx) * 180 / RAID_PI - 90
		var pitch = -Math.atan2(dy, horiz) * 180 / RAID_PI
		// разброс прицела: часть пуль уходит мимо
		yaw += (Math.random() * 2 - 1) * RAID_AIM_SPREAD_YAW
		pitch += (Math.random() * 2 - 1) * RAID_AIM_SPREAD_PITCH

		if (isNaN(yaw) || isNaN(pitch)) {
			raidErr("стрельба: угол получился NaN (yaw=" + yaw + " pitch=" + pitch + ") - выстрел пропущен")
			return false
		}

		// разворачиваем моба на цель, иначе он стреляет вперёд себя, а смотрит вбок.
		// Имена KubeJS: setYRot/setXRot он переименовал в setYaw/setPitch (EntityMixin,
		// @RemapForJS), под старыми именами функций нет - исключение отменяло выстрел.
		// Поворот нужен только для вида (направление пули задают аргументы shoot()),
		// поэтому его сбой больше не отменяет выстрел, а пишется в лог один раз.
		try {
			entity.setYaw(yaw)
			entity.setPitch(pitch)
			entity.setYHeadRot(yaw)
		} catch (e) {
			if (!st.rotWarned) {
				st.rotWarned = true
				raidErr("стрельба: не удалось развернуть " + entity.getType() + " на цель", e)
			}
		}

		var operator = RAID_IGunOperatorClass.fromLivingEntity(entity)
		var result = String(operator.shoot(() => raidFloat(pitch), () => raidFloat(yaw)))

		if (result === 'NOT_DRAW') {
			st.drawn = false
		} else if (result === 'NEED_BOLT') {
			// у болтовых винтовок (m700, springfield1873) между выстрелами нужен затвор
			try { operator.bolt() } catch (e) { raidErr("стрельба: bolt() не сработал", e) }
		} else if (result === 'NO_AMMO') {
			raidRefillAmmo(entity)
		} else if (result === 'ID_NOT_EXIST' || result === 'NOT_GUN') {
			st.drawn = false
			if (typeof global.TFG_REARM_GUNNER === 'function') global.TFG_REARM_GUNNER(entity)
		}

		// в лог - только смена исхода: автомат иначе засыпал бы лог каждым выстрелом
		if (result !== st.last && !RAID_SHOOT_WAIT[result]) {
			raidLog("стрельба: " + entity.getType() + " -> " + result + " (дистанция " + Math.round(Math.sqrt(distSq)) + ")")
		}
		st.last = result
		return result === 'SUCCESS'
	} catch (e) {
		raidErr("стрельба: исключение при выстреле у " + entity, e)
		return false
	}
}

// ─── Бой рейдеров-хасков: бег, укрытия, луки, арбалеты, дротики ─────────────
/**
 * Хаск сам умеет одно - идти на цель с вытянутыми руками (ZombieAttackGoal, скорость зомби 0.23).
 * Поверх него (решения - раз в RAID_AI_INTERVAL_TICKS, выстрелы - раз в RAID_FIRE_TICKS):
 *  - рукопашные в бою бегут: база скорости 0.26 и спринт (x1.3) - почти как бегущий игрок;
 *  - стрелки (TACZ, лук, арбалет, заводной лук Species) в рукопашную не лезут - ZombieAttackGoal с них
 *    снят - а занимают точку на дистанции своего оружия с линией огня, лучше за укрытием (блок перед
 *    собой или стена сбоку), и бьют оттуда; цель подошла вплотную или ушла - перебегают на новую точку;
 *  - с дротиками TFC бегут в рукопашную и на подходе мечут дротики.
 * Состояние - только в памяти скрипта (как RAID_GUN_STATE): после перезагрузки чанка всё пересчитается.
 */
const RAID_FIRE_TICKS = 4
// Стрелки не должны расстреливать сразу: заметив цель, выжидают RAID_REACTION_TICKS; между выстрелами
// ствола - пауза (автомат превращается в редкие одиночные); прицел с разбросом в градусах.
const RAID_REACTION_TICKS = 50
const RAID_GUN_PAUSE_MIN = 14
const RAID_GUN_PAUSE_SPREAD = 16
const RAID_AIM_SPREAD_YAW = 4.5
const RAID_AIM_SPREAD_PITCH = 3
const RAID_COMBAT_MEMORY = 200          // 10 с без линии огня ещё ищут цель, потом - к укрытию рейда
const RAID_MELEE_SPEED = 0.26
const RAID_RANGED_SPEED = 0.25
const RAID_FOLLOW_RANGE = 48
const RAID_COVER_SAMPLES = 18
const RAID_COVER_SPREAD = 1.2           // +-70 градусов от линии "цель -> стрелок": не перебегать мимо игрока
const RAID_NO_LEAVES = RAID_HeightmapTypesClass.MOTION_BLOCKING_NO_LEAVES

// дистанция боя по оружию: [ближе - отходит, дальше - подходит]
const RAID_BANDS = {
	close: [6, 15], mid: [11, 24], far: [18, 34], heavy: [14, 28],
	bow: [8, 20], crossbow: [10, 24], crankbow: [7, 16], javelin: [5, 18],
}

function raidWeaponOf(entity) {
	var stack = entity.getMainHandItem()
	if (!stack || stack.isEmpty()) return { kind: "melee" }
	var gun = RAID_IGunClass.getIGunOrNull(stack)
	if (gun) {
		var gid = String(gun.getGunId(stack))
		var band = /smg|pistol|revolver|flintlock|shotgun|db_|sg914|freedom/.test(gid) ? "close"
			: /sniper|m700|springfield|k30/.test(gid) ? "far"
			: /gernade|cannon/.test(gid) ? "heavy" : "mid"
		return { kind: "gun", band: band }
	}
	var id = String(stack.id)
	if (id === "minecraft:bow") return { kind: "bow", band: "bow" }
	if (id === "minecraft:crossbow") return { kind: "crossbow", band: "crossbow" }
	if (id === "species:crankbow") return { kind: "crankbow", band: "crankbow" }
	if (id.indexOf("javelin") >= 0) return { kind: "javelin", band: "javelin" }
	return { kind: "melee" }
}

function raidIsRanged(w) {
	return w.kind === "gun" || w.kind === "bow" || w.kind === "crossbow" || w.kind === "crankbow"
}

var RAID_AI = {}       // uuid -> { entity, weapon, target, seenAt, cover, coverFrom, coverUntil, nextShot, burst }
var RAID_COVERS = {}   // uuid -> занятая точка: двое в одну не лезут

function raidAiState(entity, now) {
	var key = raidGunKey(entity)
	var st = RAID_AI[key]
	if (!st) st = RAID_AI[key] = { seenAt: -99999, cover: null, coverUntil: 0, nextShot: now + 20, burst: 0, checkedAt: -99999 }
	if (now - st.checkedAt > 100) {    // оружие могли сменить (TFG_REARM_GUNNER)
		st.weapon = raidWeaponOf(entity)
		st.checkedAt = now
	}
	st.entity = entity
	return st
}

var RAID_GOAL_FIELD = null
var RAID_AI_SETUP_WARNED = false

// Mob.goalSelector защищён; на сервере Forge поле называется по SRG - f_21345_ (сверено по refmap модов)
function raidGoalSelector(entity) {
	if (!RAID_GOAL_FIELD) {
		var c = entity.getClass()
		while (c && String(c.getName()) !== "net.minecraft.world.entity.Mob") c = c.getSuperclass()
		var f = c.getDeclaredField("f_21345_")
		f.setAccessible(true)
		RAID_GOAL_FIELD = f
	}
	return RAID_GOAL_FIELD.get(entity)
}

/** Хаск-рейдер под своё оружие. Зовёт primitive_creatures/bandit_roles.js при спавне и при загрузке чанка. */
function raidSetupAi(entity) {
	if (String(entity.type) !== "minecraft:husk") return
	var ranged = raidIsRanged(raidWeaponOf(entity))
	try {
		raidGoalSelector(entity).removeAllGoals(g => g instanceof RAID_MoveThroughVillageGoalClass ||
			(ranged && (g instanceof RAID_ZombieAttackGoalClass || g instanceof RAID_RandomStrollGoalClass)))
	} catch (e) {
		if (!RAID_AI_SETUP_WARNED) {
			RAID_AI_SETUP_WARNED = true
			raidErr("ИИ рейдера: цели хаска не поменялись - стрелки полезут в рукопашную", e)
		}
	}
	try {
		entity.setAttributeBaseValue("minecraft:generic.movement_speed", ranged ? RAID_RANGED_SPEED : RAID_MELEE_SPEED)
		entity.setAttributeBaseValue("minecraft:generic.follow_range", RAID_FOLLOW_RANGE)
	} catch (e) { }
}

function raidTagOf(entity, prefix) {
	var it = entity.getTags().iterator()
	while (it.hasNext()) {
		var tag = String(it.next())
		if (tag.indexOf(prefix) === 0) return tag.substring(prefix.length)
	}
	return null
}

/** Пеший состоит в активном рейде: им управляет tickRaidMember, а не tfg/air_raiders_debug.js. */
function raidManaged(entity) {
	var id = raidTagOf(entity, "tfg_raid_id:")
	return id !== null && !!global.TFG_ACTIVE_RAIDS[id]
}

function raidMeleeBrain(entity, target, st, d) {
	entity.setTarget(target)
	try { entity.setSprinting(d < 48) } catch (e) { }
	// ZombieAttackGoal строит путь только в пределах дальности следования - издалека ведём сами
	var nav = entity.getNavigation()
	if (d > 24 && nav.isDone()) nav.moveTo(target.getX(), target.getY(), target.getZ(), 1.0)
}

function raidSolid(level, x, y, z) {
	var pos = new RAID_BlockPosClass(x, y, z)
	return !level.getBlockState(pos).getCollisionShape(level, pos).isEmpty()
}

function raidFree(level, x, y, z) {
	var pos = new RAID_BlockPosClass(x, y, z)
	var state = level.getBlockState(pos)
	return state.getCollisionShape(level, pos).isEmpty() && state.getFluidState().isEmpty()
}

function raidCoverTaken(key, x, y, z) {
	for (var k in RAID_COVERS) {
		if (k === key) continue
		var c = RAID_COVERS[k]
		if (Math.abs(c.x - x) <= 2 && Math.abs(c.z - z) <= 2 && Math.abs(c.y - y) <= 2) return true
	}
	return false
}

function raidClearShot(level, entity, fx, fy, fz, tx, ty, tz) {
	var ctx = new RAID_ClipContextClass(new RAID_Vec3Class(fx, fy, fz), new RAID_Vec3Class(tx, ty, tz),
		RAID_ClipBlockClass.COLLIDER, RAID_ClipFluidClass.NONE, entity)
	return level.clip(ctx).getType().ordinal() === RAID_HIT_MISS
}

// очки укрытия: блок перед собой (со стороны цели) +3, стена сбоку в рост +2, по пояс +1
function raidCoverScore(level, x, y, z, tx, tz) {
	var dx = tx - (x + 0.5)
	var dz = tz - (z + 0.5)
	var len = Math.sqrt(dx * dx + dz * dz) || 1
	var ux = Math.round(dx / len)
	var uz = Math.round(dz / len)
	var s = 0
	if ((ux !== 0 || uz !== 0) && raidSolid(level, x + ux, y, z + uz)) s += 3
	if (raidSolid(level, x - uz, y + 1, z + ux) || raidSolid(level, x + uz, y + 1, z - ux)) s += 2
	else if (raidSolid(level, x - uz, y, z + ux) || raidSolid(level, x + uz, y, z - ux)) s += 1
	return s
}

/** Точка для стрельбы: на дистанции оружия, со своей стороны от цели, с линией огня; лучше - за укрытием. */
function raidFindCover(level, entity, target, band) {
	var tx = target.getX()
	var ty = target.getY()
	var tz = target.getZ()
	var eyeY = target.getEyeY()
	var ex = entity.getX()
	var ez = entity.getZ()
	var base = Math.atan2(ez - tz, ex - tx)
	var mid = (band[0] + band[1]) / 2
	var key = raidGunKey(entity)
	var best = null
	var bestScore = -1e9
	for (var i = 0; i < RAID_COVER_SAMPLES; i++) {
		var a = base + (Math.random() * 2 - 1) * RAID_COVER_SPREAD
		var r = band[0] + Math.random() * (band[1] - band[0])
		var x = Math.floor(tx + Math.cos(a) * r)
		var z = Math.floor(tz + Math.sin(a) * r)
		var y = Number(level.getHeight(RAID_NO_LEAVES, x, z))
		if (Math.abs(y - ty) > 10) continue
		if (!raidSolid(level, x, y - 1, z) || !raidFree(level, x, y, z) || !raidFree(level, x, y + 1, z)) continue
		if (raidCoverTaken(key, x, y, z)) continue
		if (!raidClearShot(level, entity, x + 0.5, y + 1.6, z + 0.5, tx, eyeY, tz)) continue
		var score = raidCoverScore(level, x, y, z, tx, tz) - Math.abs(r - mid) * 0.15 -
			Math.sqrt((x - ex) * (x - ex) + (z - ez) * (z - ez)) * 0.06 + Math.max(0, Math.min(2, (y - ty) / 3))
		if (score > bestScore) {
			bestScore = score
			best = { x: x, y: y, z: z }
		}
	}
	return best
}

function raidRangedBrain(level, entity, target, st, now, d, sees) {
	entity.setTarget(target)
	try { entity.setSprinting(false) } catch (e) { }     // TACZ на бегу не стреляет (IS_SPRINTING)
	try { entity.setAggressive(true) } catch (e) { }     // поза прицеливания у модели стрелка (EMF, optifine/cem/husk3.jem)
	var band = RAID_BANDS[st.weapon.band] || RAID_BANDS.close
	var nav = entity.getNavigation()
	var key = raidGunKey(entity)
	var tx = target.getX()
	var tz = target.getZ()
	var tooClose = d < band[0] - 2
	var moved = !st.coverFrom || Math.pow(tx - st.coverFrom[0], 2) + Math.pow(tz - st.coverFrom[1], 2) > 64
	if (st.cover && !tooClose && d <= band[1] + 6 && now < st.coverUntil && !moved && (sees || now - st.seenAt < 60)) {
		// точка ещё годится: дойти и стоять
		var cx = st.cover.x + 0.5
		var cz = st.cover.z + 0.5
		if (Math.pow(entity.getX() - cx, 2) + Math.pow(entity.getZ() - cz, 2) <= 2.25) nav.stop()
		else if (nav.isDone()) nav.moveTo(cx, st.cover.y, cz, 1.15)
		return
	}
	st.coverFrom = [tx, tz]
	var spot = raidFindCover(level, entity, target, band)
	if (spot && nav.moveTo(spot.x + 0.5, spot.y, spot.z + 0.5, tooClose ? 1.3 : 1.15)) {
		st.cover = spot
		RAID_COVERS[key] = spot
		st.coverUntil = now + 160 + Math.floor(Math.random() * 160)   // 8-16 с на точке, потом перебежка
		return
	}
	st.cover = null
	delete RAID_COVERS[key]
	st.coverUntil = now
	// укрытия нет: держим дистанцию по прямой
	if (tooClose || d > band[1]) {
		var k = tooClose ? -1 : 1
		var step = tooClose ? 8 : Math.min(12, d - band[1] + 3)
		var ux = (tx - entity.getX()) / Math.max(d, 0.1)
		var uz = (tz - entity.getZ()) / Math.max(d, 0.1)
		nav.moveTo(entity.getX() + ux * k * step, entity.getY(), entity.getZ() + uz * k * step, tooClose ? 1.3 : 1.1)
	} else if (!sees) {
		nav.moveTo(tx, target.getY(), tz, 1.0)
	} else {
		nav.stop()
	}
}

/** Боевой ИИ рейдера на тик решений. false - цели нет ни в поле зрения, ни в памяти. */
function raidCombatTick(entity, target) {
	var now = RAID_SERVER.getTickCount()
	var st = raidAiState(entity, now)
	if (entity.isPassenger()) {           // на борту стреляет airGunners
		entity.setTarget(target)
		return true
	}
	if (typeof airIsBoarding === "function" && airIsBoarding(entity)) return true   // бежит на борт при отступлении
	var dx = entity.getX() - target.getX()
	var dy = entity.getY() - target.getY()
	var dz = entity.getZ() - target.getZ()
	var d = Math.sqrt(dx * dx + dy * dy + dz * dz)
	var sees = d <= RAID_VISION_RANGE && entity.hasLineOfSight(target)
	if (sees) {
		st.seenAt = now
		if (!st.seenSince) st.seenSince = now      // с какого момента видит цель - для задержки перед стрельбой
	} else if (now - st.seenAt > 40) {
		st.seenSince = 0
	}
	if (d > RAID_VISION_RANGE || (!sees && now - st.seenAt > RAID_COMBAT_MEMORY)) {
		st.target = null
		if (raidIsRanged(st.weapon)) {
			try { entity.setAggressive(false) } catch (e) { }
		}
		return false
	}
	st.target = target
	if (raidIsRanged(st.weapon)) raidRangedBrain(entity.level, entity, target, st, now, d, sees)
	else raidMeleeBrain(entity, target, st, d)
	return true
}

function raidSound(entity, id, volume, pitch) {
	try {
		entity.getServer().runCommandSilent("execute in " + String(entity.level.getDimension()) + " run playsound " + id + " hostile @a " +
			entity.getX() + " " + entity.getY() + " " + entity.getZ() + " " + volume + " " + pitch)
	} catch (e) { }
}

function raidFaceTarget(entity, dx, dy, dz) {
	try {
		var yaw = Math.atan2(dz, dx) * 180 / RAID_PI - 90
		entity.setYaw(yaw)
		entity.setPitch(-Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * 180 / RAID_PI)
		entity.setYHeadRot(yaw)
	} catch (e) { }
}

function raidAim(projectile, entity, target, velocity, inaccuracy) {
	var dx = target.getX() - entity.getX()
	var dz = target.getZ() - entity.getZ()
	var dy = target.getY(0.3333) - projectile.getY()
	var horiz = Math.sqrt(dx * dx + dz * dz)
	// поправка на падение: у скелета +0.2 от дистанции при скорости 1.6; быстрее летит - меньше падает
	projectile.shoot(dx, dy + horiz * 0.2 * 2.56 / (velocity * velocity), dz, velocity, Math.max(0.5, inaccuracy))
}

function raidShootArrow(entity, target, velocity, inaccuracy, damage, crossbow) {
	var arrow = new RAID_ArrowClass(entity.level, entity)
	raidAim(arrow, entity, target, velocity, inaccuracy)
	arrow.setBaseDamage(damage)
	if (crossbow) arrow.setShotFromCrossbow(true)
	entity.level.addFreshEntity(arrow)
}

/** Выстрел по готовности оружия. maxDist - своя дальность (стрелок на борту), иначе по оружию. */
function raidFire(entity, target, st, now, maxDist) {
	var w = st.weapon
	if (!w || w.kind === "melee") return
	var band = RAID_BANDS[w.band] || RAID_BANDS.close
	var dx = target.getX() - entity.getX()
	var dy = target.getEyeY() - entity.getEyeY()
	var dz = target.getZ() - entity.getZ()
	var distSq = dx * dx + dy * dy + dz * dz
	var reach = maxDist || band[1] + 12
	if (distSq > reach * reach || !entity.hasLineOfSight(target)) return
	// по координатам: setLookAt(цель, 60, 60) для Rhino неоднозначен между перегрузками LookControl
	try { entity.getLookControl().setLookAt(target.getX(), target.getEyeY(), target.getZ()) } catch (e) { }
	try { entity.setAggressive(true) } catch (e) { }
	// пеший стрелок сначала замечает цель (стрелкам на борту аппарата задержка не нужна - они далеко)
	if (!maxDist && (!st.seenSince || now - st.seenSince < RAID_REACTION_TICKS)) return
	if (w.kind === "gun") {
		if (now < (st.nextGunShot || 0)) return
		if (raidTryShoot(entity, target, distSq)) st.nextGunShot = now + RAID_GUN_PAUSE_MIN + Math.floor(Math.random() * RAID_GUN_PAUSE_SPREAD)
		return
	}
	if (now < st.nextShot) return
	if (w.kind === "javelin" && (distSq < 25 || distSq > 18 * 18)) return   // вплотную - рукопашная
	var allyBlocks = true
	try { allyBlocks = raidAllyInLine(entity, target) } catch (e) { }
	if (allyBlocks) return
	raidFaceTarget(entity, dx, dy, dz)
	var tier = Math.max(1, Math.min(5, Number(entity.persistentData.getInt("tfg_bandit_tier")) || 1))
	if (w.kind === "bow") {
		raidShootArrow(entity, target, 1.6, 7 - tier, 1.5 + tier * 0.25, false)
		raidSound(entity, "minecraft:entity.skeleton.shoot", 1, 0.9 + Math.random() * 0.2)
		st.nextShot = now + 26 + Math.floor(Math.random() * 14)
	} else if (w.kind === "crossbow") {
		raidShootArrow(entity, target, 2.4, 4 - tier * 0.5, 2.0 + tier * 0.2, true)
		raidSound(entity, "minecraft:item.crossbow.shoot", 1.2, 0.95 + Math.random() * 0.1)
		st.nextShot = now + 50 + Math.floor(Math.random() * 20)
	} else if (w.kind === "crankbow") {
		if (st.burst <= 0) {
			st.burst = 5 + Math.floor(Math.random() * 3)
			raidSound(entity, "species:item.crankbow.pull", 1, 1)
		}
		raidShootArrow(entity, target, 2.2, 5, 1.2 + tier * 0.15, true)
		raidSound(entity, "species:item.crankbow.shoot", 1, 0.9 + Math.random() * 0.2)
		st.burst--
		st.nextShot = st.burst > 0 ? now + RAID_FIRE_TICKS : now + 60 + Math.floor(Math.random() * 20)
	} else if (w.kind === "javelin") {
		var javelin = new RAID_JavelinClass(entity.level, entity, entity.getMainHandItem().copy())
		raidAim(javelin, entity, target, 1.8, 4)
		entity.level.addFreshEntity(javelin)
		try { entity.swing(RAID_MAIN_HAND) } catch (e) { }
		raidSound(entity, "tfc:item.javelin.throw", 1, 1)
		st.nextShot = now + 60 + Math.floor(Math.random() * 30)
	}
}

// стрелок на борту аппарата: только выстрел, свой темп у каждого оружия (tfg/air_raiders_debug.js)
function raidBoardFire(entity, target) {
	var now = RAID_SERVER.getTickCount()
	raidFire(entity, target, raidAiState(entity, now), now, 48)
}

function raidFireTick(now) {
	for (var key in RAID_AI) {
		var st = RAID_AI[key]
		var e = st.entity
		try {
			if (!e || !e.isAlive() || e.isRemoved()) {
				delete RAID_AI[key]
				delete RAID_COVERS[key]
				continue
			}
			var t = st.target
			if (!t || e.isPassenger()) continue
			if (!t.isAlive() || t.isRemoved()) {
				st.target = null
				continue
			}
			raidFire(e, t, st, now, 0)
		} catch (err) {
			delete RAID_AI[key]
			delete RAID_COVERS[key]
		}
	}
}

/**
 * Доля стрелков в отряде. Стрелки - те же разбойники мода, просто с ролью со
 * стволом и со скином, на котором винтовка нарисована (см. skinForRole в
 * bandit_roles.js: у этих мобов оружие - не предмет в руке, а часть текстуры).
 */
// было 0.4: на высоких тирах отряд расстреливал игрока в выживании, не давая ничего сделать
const RAID_GUNNER_SHARE = 0.2

// отряд крупнее, но рейдеры хрупче: -40% здоровья (bandit_roles.js, RAID_MEMBER_HEALTH_MULT)
const RAID_MIN_SIZE = 5
const RAID_MAX_SIZE = 8
const RAID_SPAWN_MIN_DIST = 32
const RAID_SPAWN_MAX_DIST = 64
const RAID_VISION_RANGE = 64            // "видят игрока за несколько чанков"
const RAID_SHELTER_RADIUS_XZ = 40       // "за несколько чанков" ищем укрытие
const RAID_SHELTER_RADIUS_Y = 8
const RAID_SHELTER_STRIDE = 2           // не сканировать каждый блок - дорого
const RAID_MIN_DAYS_BETWEEN = 3
const RAID_CHECK_INTERVAL_TICKS = 100   // раз в 5 сек проверяем, не наступил ли новый день
const RAID_AI_INTERVAL_TICKS = 30
const RAID_MOVE_REISSUE_TICKS = 80
const RAID_SHELTER_REACHED_DIST = 3
// общий рейд: игроки ближе этого друг к другу получают один отряд с тиром сильнейшего
const RAID_GROUP_RADIUS = 300
// итог рейда для сложности: отбит быстрее - сложнее; дольше или со смертью игрока - проще
const RAID_FAST_MINUTES = 3
const RAID_SLOW_MINUTES = 10

const TFC_ARMOR_TIER = {
	copper: 1,
	bismuth_bronze: 2, black_bronze: 2, bronze: 2,
	wrought_iron: 3, steel: 3,
	black_steel: 4,
	blue_steel: 5, red_steel: 5
}

var RAID_SERVER = null
ServerEvents.tick(event => { if (!RAID_SERVER) RAID_SERVER = event.server })

global.TFG_ACTIVE_RAIDS = global.TFG_ACTIVE_RAIDS || {} // id -> raid record

function raidLog(msg) {
	global.tfgLog("tfg raids", msg)
}
function raidErr(msg, e) {
	global.tfgLogError("tfg raids", msg, e)
}

// ─── Тир игрока по надетой броне ────────────────────────────────────────────

function armorPieceTier(stack) {
	if (!stack || stack.isEmpty()) return 0
	var id = stack.id
	for (var tier in TFC_ARMOR_TIER) {
		if (id.endsWith('/' + tier)) return TFC_ARMOR_TIER[tier]
	}
	return 0
}

function getPlayerGearTier(player) {
	var sum = armorPieceTier(player.getHeadArmorItem())
		+ armorPieceTier(player.getChestArmorItem())
		+ armorPieceTier(player.getLegsArmorItem())
		+ armorPieceTier(player.getFeetArmorItem())
	var tier = Math.round(sum / 4)
	if (tier < 1) tier = 1
	if (tier > 5) tier = 5
	return tier
}

/**
 * СОСТАВ РЕЙДА.
 *
 * Было: tier<=2 -> WEAK, tier==3 -> MEDIUM, иначе -> STRONG. И поскольку
 * STRONG_BASE состоит из ОДНОГО моба (primitive_creatures:iloger_3, он же
 * "Костолом" - iloger_10/Берсерк оттуда убран как неубиваемый), любой игрок в
 * броне тира 4-5 получал рейд из пяти одинаковых Костоломов. Подтверждено
 * логом: "tier посчитан = 5" -> "pool для tier=5 -> 1 записей" -> пять summon
 * подряд с одним и тем же primitive_creatures:iloger_3.
 *
 * ПОЧЕМУ НЕЛЬЗЯ ПРОСТО ДОСЫПАТЬ МОБОВ В STRONG_BASE: эти три массива в
 * bandit_roles.js задают не только состав рейда, но и то, какие РОЛИ (оружие,
 * броня) может получить моб при ЛЮБОМ спавне - в том числе в обычных лагерях
 * ворлдгена. Расширив STRONG_BASE, мы бы выдали топ-тир снарягу рядовым мобам
 * из слабых лагерей, против чего этот файл прямо и предостерегает.
 *
 * Поэтому состав рейда описан отдельно и смешанный: элита + рядовые. Числа -
 * доли в жребии, а не количество мобов.
 */
const RAID_COMPOSITION = {
	1: { weak: 1 },
	2: { weak: 1 },
	3: { medium: 3, weak: 1 },
	4: { strong: 2, medium: 2 },
	5: { strong: 3, medium: 2 },
}

function raidGroupArray(groupName) {
	if (groupName === 'weak') return global.TFG_BANDIT_WEAK_BASE
	if (groupName === 'medium') return global.TFG_BANDIT_MEDIUM_BASE
	return global.TFG_BANDIT_STRONG_BASE
}

/**
 * Разворачивает состав тира в плоский список id мобов, где каждая группа
 * повторена по своей доле - дальше рейд просто берёт из него случайный элемент
 * (тот же приём выбора, что и раньше).
 */
function entityPoolForTier(tier) {
	var comp = RAID_COMPOSITION[tier] || RAID_COMPOSITION[5]
	var pool = []
	for (var groupName in comp) {
		var group = raidGroupArray(groupName)
		if (!group || group.length === 0) continue
		for (var share = 0; share < comp[groupName]; share++) {
			for (var gi = 0; gi < group.length; gi++) pool.push(group[gi])
		}
	}
	return pool
}

// ─── Поиск укрытия ───────────────────────────────────────────────────────────
// "Крыша" = нет неба над блоком. Плюс хотя бы одно из: кровать, мебель из
// mcw_tfc_aio (Macaw's), источник света (факел/фонарь/лампа - любой мод, по
// getLightEmission, а не по списку конкретных id).

/**
 * state.is(BlockTagsClass.BEDS) падает - подтверждено логом: BlockStateBase
 * имеет и is(TagKey), и is(Block), и Rhino на TagKey-аргументе снова не
 * может выбрать (та же болезнь, что у FluidStack/Integer.valueOf). Явно
 * достаём метод is(TagKey) через рефлексию - никакой Rhino-угадайки.
 */
function stateIsBedTag(state) {
	try {
		var method = state.getClass().getMethod('is', RAID_TagKeyClass)
		return method.invoke(state, BlockTagsClass.BEDS) === true
	} catch (e) {
		return false // не даём одной непонятной позиции обрушить весь поиск укрытия
	}
}

function looksLikeShelter(level, pos) {
	if (level.canSeeSky(pos)) return false
	var state = level.getBlockState(pos)
	if (stateIsBedTag(state)) return true
	if (state.getLightEmission() > 0) return true
	var block = state.getBlock()
	var key = RAID_ForgeRegistriesClass.BLOCKS.getKey(block)
	if (key !== null && key.getNamespace() === 'mcw_tfc_aio') return true
	return false
}

function findShelter(level, cx, cy, cz) {
	var best = null
	var bestDistSq = Infinity
	for (var dx = -RAID_SHELTER_RADIUS_XZ; dx <= RAID_SHELTER_RADIUS_XZ; dx += RAID_SHELTER_STRIDE) {
		for (var dz = -RAID_SHELTER_RADIUS_XZ; dz <= RAID_SHELTER_RADIUS_XZ; dz += RAID_SHELTER_STRIDE) {
			for (var dy = -RAID_SHELTER_RADIUS_Y; dy <= RAID_SHELTER_RADIUS_Y; dy++) {
				var x = cx + dx, y = cy + dy, z = cz + dz
				var pos = new RAID_BlockPosClass(x, y, z)
				if (!level.isLoaded(pos)) continue
				if (!looksLikeShelter(level, pos)) continue
				var distSq = dx * dx + dy * dy + dz * dz
				if (distSq < bestDistSq) {
					bestDistSq = distSq
					best = { x: x, y: y, z: z }
				}
			}
		}
	}
	return best
}

// ─── Спавн рейда ──────────────────────────────────────────────────────────

/** Игроки в том же измерении ближе RAID_GROUP_RADIUS к игроку, включая его самого. */
function raidGroupOf(player) {
	var out = [player]
	var dim = String(player.level.getDimension())
	RAID_SERVER.players.forEach(p => {
		if (String(p.username) === String(player.username)) return
		if (String(p.level.getDimension()) !== dim) return
		var dx = p.getX() - player.getX()
		var dz = p.getZ() - player.getZ()
		if (dx * dx + dz * dz <= RAID_GROUP_RADIUS * RAID_GROUP_RADIUS) out.push(p)
	})
	return out
}

/**
 * Лётный транспорт рейда (airSpawn из tfg/air_raiders_debug.js): сталь - винтокрылы, чёрная сталь -
 * дирижабли и грузовые, синяя и красная сталь и выше - боевые. Число по сложности: от 1 до 3.
 */
function raidSpawnAircraft(player, record) {
	if (typeof airSpawn !== "function" || record.ptier < 4) return 0
	var n = Math.max(1, Math.min(3, Math.round(record.difficulty * 2 - 1)))
	var done = 0
	for (var i = 0; i < n; i++) {
		var type = record.ptier >= 6 ? "warship" : (record.ptier === 5 ? (Math.random() < 0.5 ? "airship" : "cargo_airship") : "gyrodyne")
		try {
			raidLog("рейд " + record.id + ": транспорт - " + airSpawn(player, type))
			done++
		} catch (e) {
			raidErr("рейд " + record.id + ": транспорт " + type + " не вышел", e)
		}
	}
	return done
}

// гибель игрока из группы - рейд засчитается тяжёлым (зовёт tfg/raid_tiers.js)
global.TFG_RAID_PLAYER_DIED = function (player) {
	var name = String(player.username)
	for (var id in global.TFG_ACTIVE_RAIDS) {
		var rec = global.TFG_ACTIVE_RAIDS[id]
		if (rec.groupNames && rec.groupNames.indexOf(name) >= 0) rec.playerDied = true
	}
}

function spawnRaid(player, tierOverride) {
	raidLog("spawnRaid: вызов для " + (player ? (player.username || '<без username>') : '<player=null>') + ", tierOverride=" + tierOverride)

	if (!player) {
		raidErr("spawnRaid: player is null/undefined - выхожу")
		return false
	}
	if (!RAID_SERVER) {
		raidErr("spawnRaid: RAID_SERVER ещё не инициализирован (первый ServerEvents.tick не успел отработать?)")
		return false
	}

	var level
	try {
		level = player.level
		raidLog("spawnRaid: level получен ок (" + level + ")")
	} catch (e) {
		raidErr("spawnRaid: не удалось получить player.level", e)
		return false
	}

	// Тир - не по надетой броне, а по счётчику прогресса (tfg/raid_tiers.js). Игроки рядом
	// (RAID_GROUP_RADIUS) получают один отряд с тиром и сложностью сильнейшего.
	var group = raidGroupOf(player)
	var ptier = 1
	var difficulty = 1
	group.forEach(p => {
		var gt = global.TFG_PLAYER_TIER ? global.TFG_PLAYER_TIER(p) : getPlayerGearTier(p)
		if (gt >= ptier) {
			ptier = gt
			difficulty = global.TFG_RAID_DIFFICULTY ? global.TFG_RAID_DIFFICULTY(p) : 1
		}
	})
	if (tierOverride) ptier = tierOverride
	// состав отряда (RAID_COMPOSITION) по-прежнему 1..5
	var tier = Math.min(5, ptier)
	raidLog("spawnRaid: группа " + group.map(p => String(p.username)).join(", ") + " - тир игрока " + ptier +
		", сложность " + difficulty.toFixed(2) + ", состав " + tier)

	var pool = entityPoolForTier(tier)
	raidLog("spawnRaid: pool для tier=" + tier + " -> " + (pool ? (pool.length + " записей") : "null"))
	if (!pool || pool.length === 0) {
		raidLog("Нет пула мобов для тира " + tier + " - проверь, что bandit_roles.js загрузился раньше (priority)")
		return false
	}

	var size = RAID_MIN_SIZE + Math.floor(Math.random() * (RAID_MAX_SIZE - RAID_MIN_SIZE + 1))
	// сложность и игроки в группе - крупнее отряд; на тирах 7+ снаряжение уже не растёт - ещё крупнее
	size = Math.round(size * difficulty * (1 + 0.5 * (group.length - 1)) * (ptier >= 7 ? 1 + 0.15 * (ptier - 6) : 1))
	size = Math.max(3, Math.min(16, size))
	var dist = RAID_SPAWN_MIN_DIST + Math.floor(Math.random() * (RAID_SPAWN_MAX_DIST - RAID_SPAWN_MIN_DIST + 1))
	// Math.PI в этом Rhino оказался NaN/undefined на практике (подтверждено логом -
	// ox/oz внизу выходили NaN, из-за чего /summon получал координаты "~NaN ~ ~NaN" и
	// молча не создавал моба - результат команды был 0). Проверено в чистом Node - та
	// же формула с нормальным Math.PI даёт корректные числа, так что дело именно в
	// Rhino-окружении этого пака, а не в логике. На всякий случай не полагаемся на
	// Math.PI вообще - берём числовой литерал напрямую, плюс логируем фактическое
	// значение Math.PI, чтобы диагноз был подтверждён, а не предположен.
	raidLog("spawnRaid: диагностика - typeof Math.PI=" + (typeof Math.PI) + " Math.PI=" + Math.PI)
	var RAID_TWO_PI = 6.283185307179586
	var angle = Math.random() * RAID_TWO_PI
	var ox = Math.round(Math.cos(angle) * dist)
	var oz = Math.round(Math.sin(angle) * dist)
	raidLog("spawnRaid: size=" + size + " dist=" + dist + " angle=" + angle + " ox=" + ox + " oz=" + oz)

	var targetUUID
	try {
		// .getUUID() как вызов функции падает в этом KubeJS ("Cannot find function
		// getUUID") - подтверждено логом. .uuid как СВОЙСТВО - паттерн из родного
		// скрипта пака (fishing_nets/events.fishing_nets.js), но там используется
		// ТОЛЬКО как текст внутри команды (tp ${target.uuid} ...), никогда не
		// передаётся как аргумент в Java-метод вида getPlayer(UUID) - т.е. что именно
		// возвращает .uuid (строку или живой java.util.UUID) там ни разу не
		// проверялось. Логируем тип явно, чтобы не гадать дальше.
		targetUUID = player.uuid
		raidLog("spawnRaid: player.uuid = " + targetUUID + " (typeof=" + (typeof targetUUID) + ")")
	} catch (e) {
		raidErr("spawnRaid: ошибка при чтении player.uuid", e)
		return false
	}

	// Раньше повторные вызовы /tfgraid просто ДОБАВЛЯЛИ ещё группу поверх уже
	// активной (никакого лимита не было) - при нескольких вызовах подряд толпа
	// накапливалась (участников становилось 6, 7, 10...), и это выглядело как
	// "непобедимый противник с бесконечной регенерацией", хотя на деле это были
	// РАЗНЫЕ мобы - просто игрок убивал одного, а рядом уже стоял следующий из
	// предыдущего вызова. Явного реген-эффекта нигде в коде нет (проверено -
	// ни в bandit_roles.js, ни здесь никакой MobEffect/Potion не применяется).
	// Теперь - один активный рейд на игрока одновременно.
	for (var existingId in global.TFG_ACTIVE_RAIDS) {
		if (global.TFG_ACTIVE_RAIDS[existingId].targetUUID === targetUUID) {
			raidLog("spawnRaid: у " + player.username + " уже есть активный рейд (" + existingId + ") - новый не создаю")
			return false
		}
	}

	var id = "" + RAID_SERVER.getTickCount() + "_" + Math.floor(Math.random() * 100000)
	var record = {
		id: id,
		tier: tier,
		ptier: ptier,
		difficulty: difficulty,
		groupNames: group.map(p => String(p.username)),
		playerDied: false,
		targetUUID: targetUUID,
		members: [],           // UUID, довалидируются на первом AI-тике (level берём через targetPlayer.level)
		shelter: null,
		spawnedAt: RAID_SERVER.getTickCount()
	}
	global.TFG_ACTIVE_RAIDS[id] = record
	raidLog("spawnRaid: запись создана, id=" + id + ", активных рейдов сейчас=" + Object.keys(global.TFG_ACTIVE_RAIDS).length)

	// player.blockX/blockY/blockZ не существуют в этой версии KubeJS (EntityKJS их не
	// даёт) - Rhino на несуществующем свойстве тихо возвращает undefined, undefined+ox
	// превращается в NaN, а NaN в конструкторе BlockPos валится с ошибкой без внятного
	// сообщения в лог - похоже, это и была причина "непредвиденной ошибки" у /tfgraid.
	// Правильный путь - тот же, что уже проверенно работает в energy_bridge.js: сырые
	// getX()/getY()/getZ() (double) + Math.floor().
	// игрок в своём поселении (factions/settlements.js) - рейд собирается вокруг центра базы и идёт к нему
	var raidBase = global.TFG_SETTLEMENTS ? global.TFG_SETTLEMENTS.baseFor(player) : null
	var groupCx = (raidBase ? raidBase.x : Math.floor(player.getX())) + ox
	var groupCz = (raidBase ? raidBase.z : Math.floor(player.getZ())) + oz

	// РЕЙДЕРЫ СПАВНИЛИСЬ ПОД ЗЕМЛЁЙ: раньше Y брался как "~" (тот же Y, что у
	// игрока), а X/Z сдвигались на 32-64 блока в сторону. TFC-рельеф на такой
	// дистанции легко отличается от игрока на много блоков по высоте (холм,
	// обрыв, пещера) - на Y игрока в сдвинутой точке вполне может оказаться
	// сплошная порода или пустота пещеры. Теперь Y каждого моба берём отдельно
	// через level.getHeight(MOTION_BLOCKING, x, z) - это тот же метод, которым
	// ванильный /summon без указанного Y сам находит поверхность, и результат
	// уже абсолютная Y-координата верхнего непрозрачного блока в этой точке.
	var groupCy = level.getHeight(RAID_MOTION_BLOCKING, groupCx, groupCz)
	raidLog("spawnRaid: точка группы x=" + groupCx + " z=" + groupCz + " -> поверхность y=" + groupCy)

	for (var i = 0; i < size; i++) {
		var sx = groupCx + Math.floor(Math.random() * 5) - 2
		var sz = groupCz + Math.floor(Math.random() * 5) - 2
		var sy = level.getHeight(RAID_MOTION_BLOCKING, sx, sz)
		try {
			var gs2 = global.TFG_GROUND_SPOT ? global.TFG_GROUND_SPOT(level, sx, sz, 8) : null
			if (gs2) { sx = Math.floor(gs2.x); sz = Math.floor(gs2.z); sy = gs2.y }
		} catch (e) { }
		// стрелки - с любого тира: луки и дротики с первого, арбалеты, заводной лук и стволы - по тиру игрока
		// (роли в bandit_roles.js; пока реестр стволов TACZ пуст во время /reload - роли без стволов)
		var isGunner = Math.random() < RAID_GUNNER_SHARE
		var ent = pool[Math.floor(Math.random() * pool.length)]
		// tfg_raid_tier:<n> - чтобы bandit_roles.js выдал рейдеру экипировку по
		// ТИРУ РЕЙДА, а не по тому, из какой группы этот моб взят. Иначе рядовой
		// моб в рейде тира 5 приходил бы с дубиной, а элитные стволы доставались
		// бы только Костолому.
		// Модель игрока вместо модели мода (оружие и броня видны): хаск с типом бандита в теге, см.
		// primitive_creatures/bandit_roles.js. Укротитель остаётся собой - его звери завязаны на модель мода.
		var asHusk = ent !== 'primitive_creatures:wiloger'
		var cmd = 'execute as ' + player.username + ' at @s run summon ' + (asHusk ? 'minecraft:husk' : ent) +
			' ' + sx + ' ' + sy + ' ' + sz +
			' {Tags:["tfg_managed","tfg_raid","tfg_raid_id:' + id + '","tfg_raid_tier:' + tier + '","tfg_raid_ptier:' + ptier + '","tfg_raid_diff:' + Math.round(difficulty * 100) +
			'","tfg_raid_kind:' + (isGunner ? 'gunner' : 'melee') + '"' +
			(asHusk ? ',"tfg_bandit","tfg_bandit_type:' + ent + '"' : '') + ']}'
		try {
			var cmdResult = RAID_SERVER.runCommandSilent(cmd)
			raidLog("spawnRaid: summon #" + i + " -> " + cmd + " | результат=" + cmdResult)
		} catch (e) {
			raidErr("spawnRaid: исключение при summon #" + i + " (" + cmd + ")", e)
		}
	}

	// укрытие ищем один раз сразу от точки спавна группы (на её поверхностной
	// высоте, не на Y игрока), а не от игрока - нет смысла тащить их в дом игрока.
	try {
		raidLog("spawnRaid: ищу укрытие вокруг x=" + groupCx + " y=" + groupCy + " z=" + groupCz)
		record.shelter = raidBase ? { x: raidBase.x, y: raidBase.y, z: raidBase.z } : findShelter(level, groupCx, groupCy, groupCz)
		raidLog("spawnRaid: результат поиска укрытия = " + JSON.stringify(record.shelter))
	} catch (e) {
		raidErr("spawnRaid: исключение в findShelter", e)
	}

	try {
		RAID_SERVER.runCommandSilent(
			'tellraw ' + player.username +
			' [{"text":"[Рейд] ","color":"dark_red","bold":true},{"text":"Группа разбойников (тир ' + tier + ') замечена неподалёку!","color":"red"}]'
		)
	} catch (e) {
		raidErr("spawnRaid: исключение при отправке tellraw игроку", e)
	}
	var aircraft = raidSpawnAircraft(player, record)
	raidLog("Рейд " + id + " (тир игрока " + ptier + ", сложность " + difficulty.toFixed(2) + ", " + size + " чел., аппаратов " + aircraft +
		") для " + player.username + (record.shelter ? " - нашли укрытие" : " - укрытие не найдено рядом"))
	return true
}

// ─── Рейд на поселение фракции (/tfgvillage raid, factions/sieges.js) ────────

/**
 * Налёт на поселение - ТОТ ЖЕ рейд, что /tfgraid: те же метки и запись рейда, роли и
 * снаряжение (bandit_roles.js), боевой мозг и стрельба (raidCombatTick/raidFireTick),
 * голоса и добыча. Отличие одно - цель: не игрок, а поселение. Каждый рейдер бьёт
 * ближайшего жителя этого поселения или игрока рядом с ним, а без цели идёт к середине
 * поселения (record.shelter). Пока налёт в стадии «идёт», рейдеров ведёт этот файл;
 * отход, грабёж и захват - забота factions/sieges.js (рейд снимается, см. AI-тик).
 *
 * opts: { sid, vid, dim, x, z, ring, ang, size, ptier, players: [имена] }
 * Возвращает, сколько рейдеров вышло.
 */
function spawnVillageRaid(level, opts) {
	var ptier = Math.max(1, Math.min(10, opts.ptier || 1))
	var tier = Math.min(5, ptier)
	var pool = entityPoolForTier(tier)
	if (!pool || pool.length === 0) { raidErr("spawnVillageRaid: нет пула мобов для тира " + tier); return 0 }
	var id = "v" + RAID_SERVER.getTickCount() + "_" + Math.floor(Math.random() * 100000)
	var cy = 80
	try { cy = level.getHeight(RAID_MOTION_BLOCKING, Math.floor(opts.x), Math.floor(opts.z)) } catch (e) { }
	var record = {
		id: id, tier: tier, ptier: ptier, difficulty: 1,
		groupNames: opts.players || [], playerDied: false, targetUUID: null,
		village: opts.vid, siege: opts.sid, dim: opts.dim,
		members: [], shelter: { x: Math.floor(opts.x), y: cy, z: Math.floor(opts.z) },
		spawnedAt: RAID_SERVER.getTickCount(),
	}
	global.TFG_ACTIVE_RAIDS[id] = record
	var ring = opts.ring || 28
	var dists = [ring + 28, ring + 18, ring + 8]
	var n = 0
	for (var i = 0; i < opts.size; i++) {
		var a = opts.ang + (i - opts.size / 2) * 0.07
		for (var k = 0; k < dists.length; k++) {
			var x = Math.floor(opts.x + Math.cos(a) * dists[k]), z = Math.floor(opts.z + Math.sin(a) * dists[k])
			var loaded = true
			try { loaded = !!level.hasChunk(x >> 4, z >> 4) } catch (e) { }
			if (!loaded) continue
			var y = level.getHeight(RAID_MOTION_BLOCKING, x, z)
			// на крышах не появляемся: ищем землю рядом (factions/structures.js)
			try {
				var gs = global.TFG_GROUND_SPOT ? global.TFG_GROUND_SPOT(level, x, z, 8) : null
				if (global.TFG_GROUND_SPOT) { if (!gs) continue; x = Math.floor(gs.x); z = Math.floor(gs.z); y = gs.y }
			} catch (e) { }
			var isGunner = Math.random() < RAID_GUNNER_SHARE
			var ent = pool[Math.floor(Math.random() * pool.length)]
			var asHusk = ent !== 'primitive_creatures:wiloger'
			var cmd = 'execute in ' + opts.dim + ' run summon ' + (asHusk ? 'minecraft:husk' : ent) + ' ' + x + ' ' + y + ' ' + z +
				' {PersistenceRequired:1b,Tags:["tfg_managed","tfg_raid","tfg_raid_id:' + id + '","tfg_raid_tier:' + tier +
				'","tfg_raid_ptier:' + ptier + '","tfg_raid_diff:100","tfg_raid_kind:' + (isGunner ? 'gunner' : 'melee') + '"' +
				',"tfg_raider","tfg_siege","tfg_siege_' + opts.sid + '"' +
				(asHusk ? ',"tfg_bandit","tfg_bandit_type:' + ent + '"' : '') + ']}'
			try { if (Number(RAID_SERVER.runCommandSilent(cmd)) > 0) n++ } catch (e) { raidErr("spawnVillageRaid: summon", e) }
			break
		}
	}
	if (!n) delete global.TFG_ACTIVE_RAIDS[id]
	raidLog("Рейд на поселение " + opts.vid + " (налёт " + opts.sid + ", тир " + ptier + "): вышло " + n + " из " + opts.size)
	return n
}

/** Цели рейда на поселение: живые жители этого поселения и игроки рядом с ним (не в творческом). */
function raidVillageTargets(level, record) {
	var out = []
	try {
		var tag = "tfg_v_" + record.village
		var list = level.getEntities()
		for (var i = 0; i < list.size(); i++) {
			var e = list.get(i)
			if (!e) continue
			try {
				if (!e.isAlive()) continue
				if (e.getTags && e.getTags().contains(tag)) { out.push(e); continue }
				if (String(e.type) === "minecraft:player" && !e.isCreative() && !e.isSpectator()) {
					var dx = e.getX() - record.shelter.x, dz = e.getZ() - record.shelter.z
					if (dx * dx + dz * dz < 96 * 96) out.push(e)
				}
			} catch (err) { }
		}
	} catch (e) { raidErr("raidVillageTargets", e) }
	return out
}

function raidNearestOf(entity, list) {
	var best = null, bd = 1e18
	list.forEach(t => {
		var dx = t.getX() - entity.getX(), dz = t.getZ() - entity.getZ()
		var d = dx * dx + dz * dz
		if (d < bd) { bd = d; best = t }
	})
	return best
}

global.TFG_RAID_VILLAGE = (level, opts) => spawnVillageRaid(level, opts)

// ─── Регистрация участников рейда, как только они реально заспавнились ──────

EntityEvents.spawned(event => {
	try {
		var raidEntity = event.entity
		var raidTags = raidEntity.getTags() // java.util.Set<String>
		var raidTagIt = raidTags.iterator()
		var sawRaidTag = false
		while (raidTagIt.hasNext()) {
			var raidTag = raidTagIt.next()
			if (!raidTag.startsWith('tfg_raid_id:')) continue
			sawRaidTag = true
			var raidId = raidTag.substring('tfg_raid_id:'.length)
			var raidRecord = global.TFG_ACTIVE_RAIDS[raidId]
			if (raidRecord) {
				raidRecord.members.push(raidEntity.uuid) // см. комментарий у targetUUID выше
				raidLog("EntityEvents.spawned: " + raidEntity + " добавлен в рейд " + raidId + ", участников теперь " + raidRecord.members.length)
			} else {
				raidErr("EntityEvents.spawned: у моба тег tfg_raid_id:" + raidId + ", но записи рейда " + raidId + " нет в global.TFG_ACTIVE_RAIDS (уже удалена или ещё не создана?)")
			}
			break
		}
		// если этот лог ни разу не появится при следующем /tfgraid - значит
		// EntityEvents.spawned вообще не срабатывает на мобов, заспавненных
		// через /summon из runCommandSilent (это и есть главная проверяемая гипотеза).
	} catch (e) {
		raidErr("EntityEvents.spawned: необработанное исключение", e)
	}
})

// ─── ИИ рейда: видимость игрока / поход к укрытию ────────────────────────────

/**
 * entity.distanceTo(player) кидает "Cannot find function distanceTo" -
 * подтверждено логом (та же категория проблемы, что раньше была с
 * .getUUID()/.getGameTime() - обычный на вид метод Entity, который этот
 * конкретный Rhino почему-то не резолвит). Из-за этого ИИ-тик падал
 * КАЖДЫЙ раз для каждого рейдера - рейд никогда не доходил до проверки
 * "все умерли", вис активным вечно и блокировал новые /tfgraid лимитом
 * "один рейд на игрока". Считаем дистанцию вручную через getX/getY/getZ -
 * тот же приём уже используется чуть ниже для укрытия и там ошибок нет.
 */
// Бегство: живых осталось RAID_FLEE_SHARE от наибольшего числа и меньше - бегут от цели и исчезают вне поля зрения игроков.
const RAID_FLEE_SHARE = 0.4
const RAID_FLEE_SPEED = 1.3

function raidFleeTick(level, entity, player, record) {
	try { entity.setTarget(null) } catch (e) { }
	try { entity.setAggressive(false) } catch (e) { }
	try { var st = RAID_AI[raidGunKey(entity)]; if (st) st.target = null } catch (e) { }
	var fx = record.fleeFrom ? record.fleeFrom.x : (player ? player.getX() : entity.getX())
	var fz = record.fleeFrom ? record.fleeFrom.z : (player ? player.getZ() : entity.getZ())
	var dx = entity.getX() - fx
	var dz = entity.getZ() - fz
	var d = Math.sqrt(dx * dx + dz * dz) || 1
	// исчезают, когда отбежали и никто не видит (gsSeen - factions/guests.js)
	var seen = typeof gsSeen === "function" ? gsSeen(level, entity) : !!level.getNearestPlayer(entity, 48)
	if (d > 24 && !seen) {
		entity.discard()
		return
	}
	var nav = entity.getNavigation()
	if (nav.isDone() || (RAID_SERVER.getTickCount() % 90) === 0) {
		nav.moveTo(entity.getX() + dx / d * 30, entity.getY(), entity.getZ() + dz / d * 30, RAID_FLEE_SPEED)
	}
}

function tickRaidMember(level, entity, player, record) {
	try {
		if (record.fleeing) return raidFleeTick(level, entity, player, record)
		// бой: рукопашные бегут на цель, стрелки занимают позиции (raidCombatTick), выстрелы - raidFireTick
		if (player && raidCombatTick(entity, player)) return
		try { entity.setSprinting(false) } catch (e) { }
		// игрока не видно - если есть куда идти и мы ещё не пришли, топаем к укрытию
		if (!record.shelter) return
		var s = record.shelter
		var dx = entity.getX() - (s.x + 0.5)
		var dy = entity.getY() - s.y
		var dz = entity.getZ() - (s.z + 0.5)
		var distSq = dx * dx + dy * dy + dz * dz
		if (distSq <= RAID_SHELTER_REACHED_DIST * RAID_SHELTER_REACHED_DIST) {
			return // на месте, стоим/держим оборону силами штатного ИИ
		}
		var nav = entity.getNavigation()
		if (nav.isDone() || (RAID_SERVER.getTickCount() % RAID_MOVE_REISSUE_TICKS) === 0) {
			nav.moveTo(s.x + 0.5, s.y, s.z + 0.5, 1.0)
		}
	} catch (e) {
		raidErr("tickRaidMember: необработанное исключение для " + entity, e)
	}
}

/** Общий рейд: игроки рядом (RAID_GROUP_RADIUS) - одна группа и один отряд на сильнейшего, одиночки - свой. */
function raidStartForAll(server, reason) {
	var players = server.getPlayerList().getPlayers()
	var used = {}
	var started = 0
	var groups = 0
	for (var i = 0; i < players.length; i++) {
		var p = players[i]
		if (used[String(p.username)]) continue
		var group = raidGroupOf(p)
		group.forEach(g => { used[String(g.username)] = true })
		groups++
		var target = p
		var best = -1
		group.forEach(g => {
			var gt = global.TFG_PLAYER_TIER ? global.TFG_PLAYER_TIER(g) : 1
			if (gt > best) {
				best = gt
				target = g
			}
		})
		try {
			if (spawnRaid(target, null)) started++
		} catch (e) {
			raidErr("общий рейд: отряд для " + target.username, e)
		}
	}
	raidLog("общий рейд (" + reason + "): отрядов " + started + " на групп " + groups + ", игроков " + players.length)
	return started
}

ServerEvents.tick(event => {
	var raidTick = event.server.getTickCount()

	// --- раз в RAID_CHECK_INTERVAL_TICKS: суточный розыгрыш - ОДИН на весь сервер ---
	// Раньше кубик бросался для каждого игрока отдельно, и рейды приходили вразнобой.
	// Теперь при выпадении рейд идёт сразу у всех онлайн: у каждого игрока свой отряд,
	// своего тира (по его броне) и со своей целью. Даты - в данных сервера.
	if (raidTick % RAID_CHECK_INTERVAL_TICKS === 0) {
		try {
			var calendar = CalendarsClass.SERVER
			var today = Number(calendar.getTotalCalendarDays())
			var daysInMonth = Number(calendar.getCalendarDaysInMonth())
			var sd = event.server.persistentData
			var lastCheck = sd.contains('tfg_raid_last_check_day') ? Number(sd.getLong('tfg_raid_last_check_day')) : -1
			if (today !== lastCheck) {
				sd.putLong('tfg_raid_last_check_day', today)
				var lastRaid = sd.contains('tfg_raid_last_raid_day') ? Number(sd.getLong('tfg_raid_last_raid_day')) : -999
				var raidP = daysInMonth > 0 ? (2 / daysInMonth) : 0
				if (today - lastRaid < RAID_MIN_DAYS_BETWEEN) {
					raidLog("автопроверка: день " + today + " - пропуск, прошло меньше " + RAID_MIN_DAYS_BETWEEN + " дней с прошлого рейда")
				} else {
					var roll = Math.random()
					var trigger = roll < raidP
					raidLog("автопроверка: день " + today + " - бросок=" + roll.toFixed(4) + (trigger ? " < " : " >= ") + raidP.toFixed(4) + " -> " + (trigger ? "ОБЩИЙ РЕЙД" : "не в этот раз"))
					if (trigger) {
						sd.putLong('tfg_raid_last_raid_day', today)
						raidStartForAll(event.server, "день " + today)
					}
				}
			}
		} catch (e) {
			raidErr("ошибка в блоке суточного розыгрыша рейдов", e)
		}
	}

	// --- стрелки в бою: прицел и выстрел чаще, чем решения ИИ ---
	if (raidTick % RAID_FIRE_TICKS === 0) raidFireTick(raidTick)

	// --- ИИ активных рейдов ---
	// Рейдеры всегда в том же измерении, что и их цель, пока рейд активен - проще и
	// надёжнее достать level через targetPlayer, чем восстанавливать его из строки
	// измерения (ResourceKey<Level>, не ResourceLocation - лишняя возня без пользы).
	if (raidTick % RAID_AI_INTERVAL_TICKS === 0) {
		var activeIds = Object.keys(global.TFG_ACTIVE_RAIDS)
		// печатаем сводку раз в ~10 сек (каждый 6-й AI-тик), а не на каждый тик - иначе
		// лог захлебнётся; если рейдов 0 - тоже печатаем, это само по себе полезный факт.
		if ((raidTick / RAID_AI_INTERVAL_TICKS) % 6 === 0) {
			raidLog("AI-тик: активных рейдов сейчас = " + activeIds.length + (activeIds.length ? (" [" + activeIds.join(', ') + "]") : ""))
		}
		for (var raidRecId in global.TFG_ACTIVE_RAIDS) {
		  try {
			var activeRecord = global.TFG_ACTIVE_RAIDS[raidRecId]
			// Рейд на поселение: ведём, пока налёт идёт; дальше - factions/sieges.js.
			if (activeRecord.village) {
				var stage = global.TFG_SIEGE_STAGE ? global.TFG_SIEGE_STAGE(activeRecord.siege) : null
				if (stage !== "идёт") { delete global.TFG_ACTIVE_RAIDS[raidRecId]; continue }
				var vlvl = event.server.overworld()
				var vtargets = raidVillageTargets(vlvl, activeRecord)
				var valive = 0
				for (var vi = 0; vi < activeRecord.members.length; vi++) {
					var vu = activeRecord.members[vi]
					if (!vu) continue
					var vm = vlvl.getEntity(vu)
					if (!vm || !vm.isAlive()) { activeRecord.members[vi] = null; continue }
					valive++
					tickRaidMember(vlvl, vm, raidNearestOf(vm, vtargets), activeRecord)
				}
				if (valive === 0 && (raidTick - activeRecord.spawnedAt) > 200) delete global.TFG_ACTIVE_RAIDS[raidRecId]
				continue
			}
			var targetPlayer
			try {
				targetPlayer = event.server.getPlayerList().getPlayer(activeRecord.targetUUID)
			} catch (e) {
				raidErr("рейд " + raidRecId + ": исключение при getPlayerList().getPlayer(targetUUID=" + activeRecord.targetUUID + ", typeof=" + (typeof activeRecord.targetUUID) + ")", e)
				targetPlayer = null
			}
			var lvl = targetPlayer ? targetPlayer.level : null

			var aliveCount = 0
			if (lvl) {
				for (var mi = 0; mi < activeRecord.members.length; mi++) {
					var uuid = activeRecord.members[mi]
					if (!uuid) continue
					var found = lvl.getEntity(uuid)
					if (!found || !found.isAlive()) { activeRecord.members[mi] = null; continue }
					aliveCount++
					tickRaidMember(lvl, found, targetPlayer, activeRecord)
				}
			} else {
				// цель офлайн/не в этом тике - считаем группу живой, просто ждём молча
				aliveCount = activeRecord.members.filter(m => m !== null).length
			}
			// большие потери - бегство (наибольшее число живых считаем с появления: призванные приходят не сразу)
			if (lvl) {
				if (aliveCount > (activeRecord.peak || 0)) activeRecord.peak = aliveCount
				if (!activeRecord.fleeing && activeRecord.peak >= 3 && aliveCount > 0 && aliveCount <= Math.floor(activeRecord.peak * RAID_FLEE_SHARE)) {
					activeRecord.fleeing = true
					activeRecord.fleeFrom = targetPlayer ? { x: targetPlayer.getX(), z: targetPlayer.getZ() } : null
					raidLog("рейд " + raidRecId + ": осталось " + aliveCount + " из " + activeRecord.peak + " - бегство")
					;(activeRecord.groupNames || []).forEach(name => {
						var gp = event.server.getPlayerList().getPlayerByName(name)
						if (gp) gp.tell(Text.of("§c[Рейд] §fРазбойники потеряли людей и бегут!"))
					})
				}
			}
			if (aliveCount === 0 && (raidTick - activeRecord.spawnedAt) > 200) {
				// members.length здесь ключевой диагностический факт: если он 0, значит
				// EntityEvents.spawned ни разу не подхватил заспавненных через /summon
				// мобов (например, потому что этот хук не срабатывает на командный
				// summon) - тогда рейд "завершается" мгновенно (~10 сек), даже если
				// мобы живы и стоят рядом, просто потому что мы их не отследили.
				raidLog("Рейд " + raidRecId + " завершён (все погибли или разбежались). members.length=" +
					activeRecord.members.length + " (0 здесь при живых мобах = подозрение на EntityEvents.spawned)")
				raidApplyOutcome(event.server, activeRecord, raidTick)
				delete global.TFG_ACTIVE_RAIDS[raidRecId]
			}
		  } catch (e) {
			raidErr("рейд " + raidRecId + ": необработанное исключение в AI/completion-тике", e)
		  }
		}
	}
})

// ─── Консольные команды: /tfgraid [игрок] [тир 1-5] ─────────────────────────

/** Итог рейда -> поправка сложности всей группе (TFG_RAID_ADJUST из tfg/raid_tiers.js). */
function raidApplyOutcome(server, record, tick) {
	if (!global.TFG_RAID_ADJUST || !record.groupNames) return
	var minutes = (tick - record.spawnedAt) / 1200
	var delta = 0
	if (record.playerDied || minutes > RAID_SLOW_MINUTES) delta = -0.25
	else if (minutes < RAID_FAST_MINUTES) delta = 0.25
	record.groupNames.forEach(name => {
		var p = server.getPlayerList().getPlayerByName(name)
		if (p) global.TFG_RAID_ADJUST(p, delta)
	})
	raidLog("рейд " + record.id + ": итог за " + minutes.toFixed(1) + " мин" + (record.playerDied ? ", с гибелью игрока" : "") +
		" -> поправка сложности " + (delta > 0 ? "+" : "") + delta)
}

/** Короткий текст ошибки для чата: "No player was found" вместо полного имени Java-исключения. */
function raidCmdErrText(e) {
	var s = String(e)
	var i = s.lastIndexOf("Exception: ")
	return (i >= 0 ? s.substring(i + 11) : s).substring(0, 300)
}

ServerEvents.commandRegistry(event => {
	raidLog("commandRegistry: регистрирую /tfgraid")
	var Commands = event.commands
	var Arguments = event.arguments

	// В логе ни разу не было видно ни одной трассировки для "непредвиденная
	// ошибка" у /tfgraid - значит, исключение либо кидается ДО того, как
	// добираемся до тела executes() (например, при конвертации аргумента), либо
	// кидается внутри, но чем-то выше по стеку (Brigadier/KubeJS) гасится молча.
	// Оборачиваю КАЖДОЕ тело executes() в try/catch с полным console.error(e.stack)
	// и логирую сам факт входа в обработчик первой строкой - так будет видно,
	// добрались ли мы вообще до нашего кода.

	event.register(
		Commands.literal('tfgraid')
			.requires(source => source.hasPermission(2))
			.executes(ctx => {
				raidLog("/tfgraid (без аргументов): обработчик вызван")
				try {
					var player = ctx.source.getPlayerOrException()
					raidLog("/tfgraid: игрок из ctx.source = " + (player ? player.username : null))
					var ok = spawnRaid(player, null)
					ctx.source.sendSuccess(Text.of(ok ? "Рейд вызван (тир по броне игрока)." : "Не удалось вызвать рейд - подробности в логе сервера."), false)
					return 1
				} catch (e) {
					raidErr("/tfgraid (без аргументов): необработанное исключение в executes()", e)
					ctx.source.sendFailure(Text.of("Ошибка /tfgraid: " + raidCmdErrText(e)))
					return 0
				}
			})
			.then(
				Commands.literal('all')
					.executes(ctx => {
						try {
							var n = raidStartForAll(ctx.source.getServer(), "команда /tfgraid all")
							ctx.source.sendSuccess(Text.of("Общий рейд: отрядов " + n + "."), false)
							return 1
						} catch (e) {
							raidErr("/tfgraid all: необработанное исключение", e)
							ctx.source.sendFailure(Text.of("Ошибка /tfgraid all: " + raidCmdErrText(e)))
							return 0
						}
					})
			)
			.then(
				Commands.argument('player', Arguments.PLAYER.create(event))
					.executes(ctx => {
						raidLog("/tfgraid <player>: обработчик вызван")
						try {
							var player = Arguments.PLAYER.getResult(ctx, 'player')
							raidLog("/tfgraid <player>: аргумент player = " + (player ? player.username : null))
							var ok = spawnRaid(player, null)
							ctx.source.sendSuccess(Text.of(ok ? "Рейд вызван для " + player.username + " (тир по броне)." : "Не удалось вызвать рейд - подробности в логе сервера."), false)
							return 1
						} catch (e) {
							raidErr("/tfgraid <player>: необработанное исключение в executes()", e)
							ctx.source.sendFailure(Text.of("Ошибка /tfgraid: " + raidCmdErrText(e)))
							return 0
						}
					})
					.then(
						Commands.argument('tier', Arguments.INTEGER.create(event))
							.executes(ctx => {
								raidLog("/tfgraid <player> <tier>: обработчик вызван")
								try {
									var player = Arguments.PLAYER.getResult(ctx, 'player')
									var tier = Arguments.INTEGER.getResult(ctx, 'tier')
									raidLog("/tfgraid <player> <tier>: player=" + (player ? player.username : null) + " tier=" + tier)
									if (tier < 1) tier = 1
									if (tier > 10) tier = 10
									var ok = spawnRaid(player, tier)
									ctx.source.sendSuccess(Text.of(ok ? "Рейд вызван для " + player.username + " (тир " + tier + ")." : "Не удалось вызвать рейд - подробности в логе сервера."), false)
									return 1
								} catch (e) {
									raidErr("/tfgraid <player> <tier>: необработанное исключение в executes()", e)
									ctx.source.sendFailure(Text.of("Ошибка /tfgraid: " + raidCmdErrText(e)))
									return 0
								}
							})
					)
			)
	)
	raidLog("commandRegistry: /tfgraid зарегистрирован")
})

// priority: 0
"use strict";

/**
 * ЗАМОРОЗКА ЕДЫ В ПОГРЕБАХ.
 *
 * Идея: погреб FirmaLife, набитый льдом, охлаждается ниже нуля, и еда в нём
 * перестаёт портиться. Тогда имеет смысл и забивать погреб льдом, и держать
 * склад в вечной мерзлоте.
 *
 * КАК ЭТО РАБОТАЕТ В TFC. Порча зависит не от температуры, а от "черт еды"
 * (FoodTrait) с множителем: 0.5 - вдвое медленнее, 0 - порча ОСТАНОВЛЕНА.
 * Это штатное поведение TFC (см. traitPreservedModifier в tfc-server.toml),
 * не самодеятельность. Мы регистрируем свои три черты и вешаем их на еду в
 * зависимости от расчётной температуры погреба.
 *
 * ИСТОЧНИКИ ХОЛОДА - лёд из цепочки самого пака (tfg/primitive/recipes.ice.js):
 * вода -> Ice Slush (gtceu:ice) -> packed_ice, и blue_ice на вершине, он же
 * теплоотвод ядерного реактора. Веса подобраны так, чтобы 5 блоков синего льда
 * полностью замораживали погреб объёмом 90 блоков.
 *
 * ГРАНИЦЫ ПОМЕЩЕНИЯ берём у климатической станции: её приватное поле positions
 * хранит РОВНО множество блоков погреба. Значит холод считается по всей комнате,
 * а не по радиусу.
 *
 * ОПТИМИЗАЦИЯ. Проверять каждый продукт ежесекундно недопустимо дорого. Поэтому:
 *  - обходим только погреба рядом с онлайн-игроками;
 *  - температуру квантуем шагом 5 градусов;
 *  - погреб пересчитываем раз в 5 секунд, а в лог пишем только смену ступени;
 *  - с еды в инвентарях игроков черты снимаются: холод действует только на полке.
 */

// ─── Классы TFC/FirmaLife ────────────────────────────────────────────────────

const CF_FoodTraitClass = Java.loadClass("net.dries007.tfc.common.capabilities.food.FoodTrait")
const CF_FoodCapabilityClass = Java.loadClass("net.dries007.tfc.common.capabilities.food.FoodCapability")
const CF_ClimateClass = Java.loadClass("net.dries007.tfc.util.climate.Climate")
const CF_ResourceLocationClass = Java.loadClass("net.minecraft.resources.ResourceLocation")
const CF_BlockPosClass = Java.loadClass("net.minecraft.core.BlockPos")
const CF_ItemStackClass = Java.loadClass("net.minecraft.world.item.ItemStack")
const CF_FloatClass = Java.loadClass("java.lang.Float")

/**
 * Рефлексия вместо прямых вызовов - иначе Rhino выберет не ту перегрузку.
 * Подробности этой ловушки: у FoodCapability.applyTrait ДВЕ перегрузки с
 * одинаковым числом аргументов - (IFood, FoodTrait) и (ItemStack, FoodTrait), и
 * обёртки типов делают выбор непредсказуемым. У конструктора FoodTrait та же
 * беда: (float, String) против (Supplier, String).
 * Class-объект берём через загрузчик классов живого экземпляра - Java.loadClass
 * отдаёт NativeJavaClass, у которого методов java.lang.Class нет.
 */
const CF_Loader = CF_ItemStackClass.EMPTY.getClass().getClassLoader()
function cfClass(name) { return CF_Loader.loadClass(name) }

const CF_TraitCls = cfClass("net.dries007.tfc.common.capabilities.food.FoodTrait")
const CF_CapCls = cfClass("net.dries007.tfc.common.capabilities.food.FoodCapability")
const CF_StackCls = cfClass("net.minecraft.world.item.ItemStack")

const CF_ApplyMethod = CF_CapCls.getMethod("applyTrait", CF_StackCls, CF_TraitCls)
const CF_RemoveMethod = CF_CapCls.getMethod("removeTrait", CF_StackCls, CF_TraitCls)
const CF_HasMethod = CF_CapCls.getMethod("hasTrait", CF_StackCls, CF_TraitCls)


// ─── Черты еды берём из startup-скрипта ──────────────────────────────────────

/**
 * Сама регистрация - в startup_scripts/tfg/food_traits.js: она обязана
 * выполниться И на клиенте, иначе тултип еды не покажет черту.
 * Здесь только пороги температуры и логика.
 */
const CF_TRAITS = global.TFG_FOOD_TRAITS
const CF_TIERS = CF_TRAITS ? CF_TRAITS.map(t => t.def) : []
if (!CF_TRAITS) {
	global.tfgLogError('tfg cellar', 'черты еды не зарегистрированы - ' +
		'проверь startup_scripts/tfg/food_traits.js, заморозка работать не будет')
}

// ─── Холод от льда ───────────────────────────────────────────────────────────

/**
 * Вклад каждого блока в холод. Цепочка пака: вода -> Ice Slush -> packed_ice,
 * blue_ice на вершине (он же компонент охлаждения реактора).
 */
const CF_ICE_WEIGHT = {
	'minecraft:ice': 1,
	'minecraft:packed_ice': 4,
	'minecraft:blue_ice': 12,
}

/** 5 блоков синего льда (5*12=60) полностью замораживают погреб в 90 блоков. */
const CF_REFERENCE_VOLUME = 90
const CF_UNITS_PER_STEP = 12   // единиц холода на -5 градусов
const CF_MAX_DROP = 25         // ниже этого искусственный холод не опускает

const CF_STATION_BLOCK = 'firmalife:climate_station'
const CF_INTERVAL = 100        // обработка известных погребов - раз в 5 секунд
const CF_RESCAN_INTERVAL = 1200 // поиск новых станций - раз в минуту
const CF_SCAN_XZ = 12          // радиус поиска станции вокруг игрока
const CF_SCAN_Y = 6

/** Приватное поле positions у станции - там ровно блоки погреба. */
function cfCellarPositions(stationEntity) {
	try {
		var f = stationEntity.getClass().getDeclaredField('positions')
		f.setAccessible(true)
		return f.get(stationEntity)
	} catch (e) {
		return null
	}
}

function cfTraitForTemp(t) {
	for (var i = 0; i < CF_TIERS.length; i++) {
		if (t <= CF_TIERS[i].maxTemp) return i
	}
	return -1 // теплее нуля - никакой черты
}

/** Ступень температуры шагом 5 градусов - чтобы не дёргать еду на каждый градус. */
function cfStep(t) { return Math.floor(t / 5) }

// ─── Основной цикл ───────────────────────────────────────────────────────────

/**
 * ПОЧЕМУ КЭШ. Прямой перебор блоков вокруг каждого игрока - это десятки тысяч
 * обращений за проход, сервер такого не простит. Поэтому поиск станций
 * (дорогой) идёт раз в минуту и в скромном объёме, а найденные погреба
 * обрабатываются (дёшево) раз в 5 секунд по сохранённым координатам.
 */
var CF_stations = {}   // "x,y,z" -> {x,y,z}
var CF_lastStep = {}   // "x,y,z" -> последняя ступень температуры

function cfKey(x, y, z) { return x + ',' + y + ',' + z }

// Почему погреб не морозит - в лог один раз на смену причины, а для /tfgcellar - сразу в чат.
var CF_whyLogged = {}
function cfWhy(key, reason, report) {
	if (report) {
		report('погреб ' + key + ': ' + reason)
		return
	}
	if (CF_whyLogged[key] === reason) return
	CF_whyLogged[key] = reason
	global.tfgLog('tfg cellar', 'погреб ' + key + ': ' + reason)
}

ServerEvents.tick(event => {
	if (!CF_TRAITS) return
	var tick = event.server.tickCount

	// 1) редкий поиск новых станций рядом с игроками
	if (tick % CF_RESCAN_INTERVAL === 0) {
		event.server.players.forEach(player => {
			try {
				var level = player.level
				var px = Math.floor(player.getX()), py = Math.floor(player.getY()), pz = Math.floor(player.getZ())
				for (var dx = -CF_SCAN_XZ; dx <= CF_SCAN_XZ; dx++) {
					for (var dz = -CF_SCAN_XZ; dz <= CF_SCAN_XZ; dz++) {
						for (var dy = -CF_SCAN_Y; dy <= CF_SCAN_Y; dy++) {
							var x = px + dx, y = py + dy, z = pz + dz
							if (String(level.getBlock(x, y, z).id) !== CF_STATION_BLOCK) continue
							var k = cfKey(x, y, z)
							if (!CF_stations[k]) {
								CF_stations[k] = { x: x, y: y, z: z }
								global.tfgLog('tfg cellar', `найдена климатическая станция ${k}`)
							}
						}
					}
				}
			} catch (e) {
				global.tfgLogError('tfg cellar', `поиск станций у ${player.username}: ${e}`)
			}
		})
	}

	// 2) частая, но дешёвая обработка уже известных погребов
	if (tick % CF_INTERVAL !== 0) return
	var level = event.server.overworld()
	for (var k in CF_stations) {
		var st = CF_stations[k]
		try {
			var block = level.getBlock(st.x, st.y, st.z)
			if (String(block.id) !== CF_STATION_BLOCK) {   // станцию сломали
				delete CF_stations[k]; delete CF_lastStep[k]
				global.tfgLog('tfg cellar', `станция ${k} исчезла - забываю`)
				continue
			}
			cfProcessCellar(level, block)
		} catch (e) {
			// чанк выгружен - просто пропускаем до следующего раза
		}
	}
})

/**
 * Хранилище с едой - ЛЮБОЙ блок с инвентарём: полки, вешалки и шкафы FirmaLife (в том числе из деревьев TFG и
 * ArborFirmaCraft), сундуки, бочки, ящики, горшки, сосуды, рюкзаки на подставке и прочее. Раньше сверялись id
 * (food_shelf, hanger, jarbnet) - еда в сундуке или бочке в погребе не замораживалась.
 * Признак хранилища - что у блок-сущности вообще читается инвентарь (cfInventoryOf), поэтому список вести не нужно.
 */
function cfIsContainer(block) {
	try {
		var be = block.getEntity()
		return !!be && !!cfInventoryOf(block, be, true)
	} catch (e) {
		return false
	}
}

function cfProcessCellar(level, stationBlock, report) {
	var sp = stationBlock.getPos()
	var skey = sp.getX() + ',' + sp.getY() + ',' + sp.getZ()
	var station = stationBlock.getEntity()
	if (!station) {
		cfWhy(skey, 'у станции нет блок-сущности', report)
		return
	}
	var positions = cfCellarPositions(station)
	if (!positions) {
		cfWhy(skey, 'поле positions у станции не читается - другая версия FirmaLife?', report)
		return
	}
	if (positions.isEmpty()) {
		var cellarMode = '?'
		try { cellarMode = String(station.favoriteIsCellar()) } catch (e) { }
		cfWhy(skey, 'станция не видит помещение (positions пусто): погреб не замкнут изоляцией или станция его ещё не проверила; режим погреба = ' + cellarMode, report)
		return
	}

	var volume = positions.size()
	var cold = 0
	var ice = {}
	var it = positions.iterator()
	var containers = []
	var other = {}   // что ещё стоит в погребе - для разбора, если хранилищ не нашлось
	while (it.hasNext()) {
		var p = it.next()
		var block = level.getBlock(p.getX(), p.getY(), p.getZ())
		var id = String(block.id)
		if (CF_ICE_WEIGHT[id]) {
			cold += CF_ICE_WEIGHT[id]
			ice[id] = (ice[id] || 0) + 1
		} else if (cfIsContainer(block)) {
			containers.push(block)
		} else if (id !== 'minecraft:air' && id !== 'minecraft:cave_air') {
			other[id] = (other[id] || 0) + 1
		}
	}
	var iceText = Object.keys(ice).map(k => k.replace('minecraft:', '') + ' x' + ice[k]).join(', ') || 'льда внутри нет'
	if (containers.length === 0) {
		var otherText = Object.keys(other).sort((a, b) => other[b] - other[a]).slice(0, 8)
			.map(k => k + ' x' + other[k]).join(', ') || 'только воздух'
		cfWhy(skey, 'объём ' + volume + ', ' + iceText + ', но хранилищ с инвентарём не найдено; внутри: ' + otherText, report)
		return
	}

	// холод нормируем на эталонный объём: в большом погребе тот же лёд слабее
	var normalized = cold * CF_REFERENCE_VOLUME / Math.max(volume, 1)
	var drop = Math.min(CF_MAX_DROP, Math.floor(normalized / CF_UNITS_PER_STEP) * 5)

	var pos = stationBlock.getPos()
	var ambient = CF_ClimateClass.getTemperature(level, pos)
	var effective = ambient - drop
	var tierIndex = cfTraitForTemp(effective)

	// Содержимое сверяем каждый проход: иначе еда, положенная на полку уже
	// после расчёта, не получала бы черту, пока температура не сменит ступень.
	// Дёшево: на предмет три проверки hasTrait, и только в погребах у игроков.
	var applied = 0
	containers.forEach(c => { applied += cfRetagContainer(c, tierIndex) })

	var line = 'объём ' + volume + ', ' + iceText + ', холод ' + cold +
		' (норм. ' + normalized.toFixed(0) + '), ' + ambient.toFixed(1) + '°C - ' + drop + ' = ' +
		effective.toFixed(1) + '°C -> ' + (tierIndex < 0 ? 'без черты' : CF_TIERS[tierIndex].name) +
		', хранилищ ' + containers.length + ', обновлено предметов: ' + applied
	if (report) {
		report('погреб ' + skey + ': ' + line)
		return
	}
	CF_whyLogged[skey] = 'ok'
	// в лог - только смена ступени температуры или реальные перемены
	var step = cfStep(effective)
	if (CF_lastStep[skey] === step && applied === 0) return
	CF_lastStep[skey] = step
	global.tfgLog('tfg cellar', 'погреб ' + skey + ': ' + line)
}

/**
 * Инвентарь хранилища. Поле inventory объявлено в TFC InventoryBlockEntity как
 * protected: из скрипта be.inventory даёт undefined, так что первая версия и на
 * правильной полке не увидела бы ни одного предмета.
 * Берём поле рефлексией, поднимаясь по суперклассам (у вешалки оно на уровень
 * выше, чем у полки), а если не вышло - через штатный getInventory() KubeJS.
 */
var CF_invWarned = false
const CF_ItemHandlerCap = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities").ITEM_HANDLER

function cfInventoryOf(block, be, quiet) {
	try {
		var cls = be.getClass()
		while (cls) {
			try {
				var f = cls.getDeclaredField('inventory')
				f.setAccessible(true)
				var inv = f.get(be)
				if (inv && typeof inv.getSlots === 'function') return inv
				break
			} catch (e) {
				cls = cls.getSuperclass()
			}
		}
	} catch (e) { /* ниже - запасные пути */ }
	// сундуки, бочки и всё остальное: штатная способность Forge
	try {
		var cap = be.getCapability(CF_ItemHandlerCap).resolve()
		if (cap.isPresent()) return cap.get()
	} catch (e) { /* ниже */ }
	try {
		var kinv = block.getInventory()
		if (kinv && typeof kinv.getSlots === 'function') return kinv
	} catch (e) { /* ниже */ }
	if (!quiet && !CF_invWarned) {
		CF_invWarned = true
		global.tfgLogError('tfg cellar', 'не удалось открыть инвентарь ' + block.id + ' - такие хранилища пропускаются')
	}
	return null
}

/** Method.invoke возвращает java.lang.Boolean - сравниваем по строке, не через === true. */
function cfHasTrait(stack, t) {
	return String(CF_HasMethod.invoke(null, stack, CF_TRAITS[t].trait)) === 'true'
}

/**
 * Оставляет на предмете только черту tierIndex (или ни одной при -1).
 * Считает лишь реальные перемены: на не-еду черта не встаёт, и без повторной
 * проверки банка в шкафу "обновлялась" бы каждый проход.
 */
function cfRetagStack(stack, tierIndex) {
	var n = 0
	for (var t = 0; t < CF_TRAITS.length; t++) {
		var want = (t === tierIndex)
		var has = cfHasTrait(stack, t)
		if (want && !has) {
			CF_ApplyMethod.invoke(null, stack, CF_TRAITS[t].trait)
			if (cfHasTrait(stack, t)) n++
		} else if (!want && has) {
			CF_RemoveMethod.invoke(null, stack, CF_TRAITS[t].trait)
			if (!cfHasTrait(stack, t)) n++
		}
	}
	return n
}

/**
 * Сообщить клиенту, что содержимое поменялось. markForSync есть только у контейнеров
 * TFC; у ящиков и машин GregTech его нет - им хватает пометки изменений и
 * обновления блока.
 */
function cfSyncBlockEntity(containerBlock, be) {
	if (typeof be.markForSync === "function") return be.markForSync()
	if (typeof be.setChanged === "function") be.setChanged()
	else if (typeof be.m_6596_ === "function") be.m_6596_()
	var state = containerBlock.getBlockState()
	var level = containerBlock.getLevel()
	if (typeof level.sendBlockUpdated === "function") level.sendBlockUpdated(containerBlock.getPos(), state, state, 3)
	else if (typeof level.m_7260_ === "function") level.m_7260_(containerBlock.getPos(), state, state, 3)
}

function cfRetagContainer(containerBlock, tierIndex) {
	var n = 0
	try {
		var be = containerBlock.getEntity()
		if (!be) return 0
		var inv = cfInventoryOf(containerBlock, be)
		if (!inv) return 0
		var size = inv.getSlots()
		for (var i = 0; i < size; i++) {
			var stack = inv.getStackInSlot(i)
			if (!stack || stack.isEmpty()) continue
			n += cfRetagStack(stack, tierIndex)
		}
		// без синхронизации клиент увидит новую черту только после перезахода
		if (n > 0) cfSyncBlockEntity(containerBlock, be)
	} catch (e) {
		global.tfgLogError('tfg cellar', 'пометка содержимого', e)
	}
	return n
}

// ─── Холод не выносится из погреба ───────────────────────────────────────────

/**
 * Черта живёт в самом предмете. Если её не снимать, замороженную на полке еду
 * можно унести в рюкзак - и она не испортится уже никогда.
 * Раз в секунду снимаем наши черты со всего, что лежит в инвентарях игроков:
 * холод действует, только пока еда лежит в погребе.
 */
const CF_STRIP_INTERVAL = 20
var CF_stripWarned = false

ServerEvents.tick(event => {
	if (!CF_TRAITS) return
	if (event.server.tickCount % CF_STRIP_INTERVAL !== 0) return
	event.server.players.forEach(player => {
		try {
			var inv = player.getInventory()
			var size = inv.getContainerSize()
			for (var i = 0; i < size; i++) {
				var stack = inv.getItem(i)
				if (!stack || stack.isEmpty()) continue
				cfRetagStack(stack, -1)
			}
		} catch (e) {
			if (!CF_stripWarned) {
				CF_stripWarned = true
				global.tfgLogError('tfg cellar', 'снятие черт в инвентаре ' + player.username, e)
			}
		}
	})
})

// ---- /tfgcellar: разбор погребов рядом с игроком прямо в чат ----------------------------------
ServerEvents.commandRegistry(event => {
	var Commands = event.commands
	event.register(Commands.literal('tfgcellar').executes(ctx => {
		var say = msg => ctx.source.sendSuccess(Text.of(msg), false)
		try {
			if (!CF_TRAITS) {
				say('черты еды не зарегистрированы (startup_scripts/tfg/food_traits.js) - заморозка выключена')
				return 1
			}
			var player = ctx.source.getPlayerOrException()
			var level = player.level
			var px = Math.floor(player.getX())
			var py = Math.floor(player.getY())
			var pz = Math.floor(player.getZ())
			var found = 0
			for (var dx = -CF_SCAN_XZ; dx <= CF_SCAN_XZ; dx++) {
				for (var dz = -CF_SCAN_XZ; dz <= CF_SCAN_XZ; dz++) {
					for (var dy = -CF_SCAN_Y; dy <= CF_SCAN_Y; dy++) {
						var block = level.getBlock(px + dx, py + dy, pz + dz)
						if (String(block.id) !== CF_STATION_BLOCK) continue
						found++
						CF_stations[cfKey(px + dx, py + dy, pz + dz)] = { x: px + dx, y: py + dy, z: pz + dz }
						cfProcessCellar(level, block, say)
					}
				}
			}
			if (found === 0) say('климатической станции FirmaLife ближе ' + CF_SCAN_XZ + ' блоков нет - без неё погреб не считается')
		} catch (e) {
			ctx.source.sendFailure(Text.of('Ошибка /tfgcellar: ' + String(e).substring(0, 300)))
		}
		return 1
	}))
})

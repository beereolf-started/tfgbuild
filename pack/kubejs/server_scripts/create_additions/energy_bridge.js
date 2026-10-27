// priority: 0
"use strict";

/**
 * ФИКС БАГА GTCEU: Alternator (и любой другой чистый Forge-Energy генератор) не может
 * отдавать энергию в кабельную сеть GTCEU через compat.energy.nativeEUToFE.
 *
 * Причина (проверено дизассемблированием gtceu-1.20.1-7.5.3.jar через javap):
 *   com.gregtechceu.gtceu.api.capability.compat.EUToFEProvider$GTEnergyWrapper
 *   public boolean outputsEnergy(Direction d) { return false; }   // жёстко зашито
 *   public boolean inputsEnergy(Direction d)  { return energyStorage.canReceive(); }
 * То есть эта обёртка (которая делает FE-блок видимым для EU-сети кабелей) НИКОГДА не
 * считает обёрнутый блок источником энергии - сеть в принципе не пытается забрать
 * из него энергию. Приёмники (Electric Motor и т.п.) при этом работают нормально,
 * т.к. inputsEnergy честно спрашивает исходный блок.
 *
 * Это баг в скомпилированном классе мода, kubejs-ом его не пропатчить. Вместо этого
 * мы сами, вручную, раз в тик переливаем энергию из Alternator-а в любой примыкающий
 * кабель/машину GTCEU - используя ТЕ ЖЕ публичные API (ForgeCapabilities.ENERGY,
 * GTCapability.CAPABILITY_ENERGY_CONTAINER, FeCompat, IEnergyContainer.changeEnergy),
 * которыми пользуется сам GTCEU. Дальше по кабельной сети энергия сама разносится
 * штатным (рабочим) кодом GTCEU - мы вмешиваемся только в момент входа в сеть.
 */

const ForgeCapabilities = Java.loadClass("net.minecraftforge.common.capabilities.ForgeCapabilities")
const GTCapability = Java.loadClass("com.gregtechceu.gtceu.api.capability.forge.GTCapability")
const FeCompat = Java.loadClass("com.gregtechceu.gtceu.api.capability.compat.FeCompat")
const DirectionClass = Java.loadClass("net.minecraft.core.Direction")
const DIRECTIONS = DirectionClass.values()
const EB_BlockPosClass = Java.loadClass("net.minecraft.core.BlockPos")
const EB_ForgeRegistriesClass = Java.loadClass("net.minecraftforge.registries.ForgeRegistries")
const FE_TO_EU_RATIO = false // тот же аргумент, что использует сам GTEnergyWrapper (FeCompat.ratio(false))

// id блоков, которым нужен этот мост (только чистые FE-генераторы Create Additions).
// Electric Motor сюда добавлять не нужно - он потребитель, и штатный мост GTCEU
// его и так корректно кормит энергией из сети.
const BRIDGED_GENERATORS = ["createaddition:alternator"]

// ПРИМ.: раньше тут сравнивались сырые Java-объекты Block через Array.includes() -
// падало в скане (scanAroundPlayer) с ошибкой Rhino внутри NativeArray.js_includes
// (ScriptRuntime.typeof/MemberType.get) на некоторых блоках при переборе окрестности
// игрока. Сравнение по строковому id полностью безопасно для Rhino и не медленнее
// на практике (getKey() - дешёвый lookup в реестре).

// key -> { level, pos } - живые java-ссылки, действительны только в рамках текущего запуска сервера.
// global.* не переживает рестарт/reload, поэтому регистрация не полагается только на
// BlockEvents.placed/rightClicked - см. scanAroundPlayer ниже, она сама подхватывает
// уже стоящие Alternator-ы при входе игрока в мир, без ручных действий.
global.TFG_FE_BRIDGE_SOURCES = global.TFG_FE_BRIDGE_SOURCES || {}

function posKey(pos) {
	return pos.getX() + "," + pos.getY() + "," + pos.getZ()
}

function registerBridgeSource(level, pos) {
	global.TFG_FE_BRIDGE_SOURCES[posKey(pos)] = { level: level, pos: pos }
}

function unregisterBridgeSource(pos) {
	delete global.TFG_FE_BRIDGE_SOURCES[posKey(pos)]
}

// Проблема, которую этот скан решает: BlockEvents.placed/rightClicked регистрируют
// Alternator только с момента появления этого скрипта. Всё, что уже стояло в мире
// раньше (или пережило рестарт сервера - global.* не сохраняется), в реестр не попадает
// и мост для него молча не работает. Вместо того чтобы полагаться на то, что игрок
// вспомнит кликнуть по каждому Alternator-у, сканируем окрестности игрока один раз
// при входе в мир - дёшево (редкое событие), надёжно (не зависит от памяти игрока).
const SCAN_RADIUS_XZ = 32
const SCAN_RADIUS_Y = 16

function scanAroundPlayer(player) {
	// var везде ниже - функция вызывается заново при каждом входе игрока, а Rhino
	// (см. комментарий у ServerEvents.tick) падает на const/let при повторных вызовах.
	var level = player.level // в раннтайме KubeJS это свойство (проверено логом), не метод
	var px = Math.floor(player.getX())
	var py = Math.floor(player.getY())
	var pz = Math.floor(player.getZ())
	var found = 0

	for (var dx = -SCAN_RADIUS_XZ; dx <= SCAN_RADIUS_XZ; dx++) {
		for (var dz = -SCAN_RADIUS_XZ; dz <= SCAN_RADIUS_XZ; dz++) {
			for (var dy = -SCAN_RADIUS_Y; dy <= SCAN_RADIUS_Y; dy++) {
				var pos = new EB_BlockPosClass(px + dx, py + dy, pz + dz)
				if (!level.isLoaded(pos)) continue
				var block = level.getBlockState(pos).getBlock()
				var blockKey = EB_ForgeRegistriesClass.BLOCKS.getKey(block)
				if (blockKey && BRIDGED_GENERATORS.includes(blockKey.toString())) {
					registerBridgeSource(level, pos)
					found++
				}
			}
		}
	}
	if (found > 0) global.tfgLog("tfg energy_bridge", `Registered ${found} existing Alternator(s) near ${player.getName().getString()}`)
}

PlayerEvents.loggedIn(event => scanAroundPlayer(event.player))

BlockEvents.placed(event => {
	if (!BRIDGED_GENERATORS.includes(event.block.id)) return
	registerBridgeSource(event.block.level, event.block.pos)
})

BlockEvents.broken(event => {
	if (!BRIDGED_GENERATORS.includes(event.block.id)) return
	unregisterBridgeSource(event.block.pos)
})

// ПКМ по уже стоящему альтернатору (например, построенному до установки этого фикса
// или после рестарта сервера) тоже регистрирует его - штука, которую вы и так будете
// делать, проверяя блок. event.block.level используется намеренно вместо event.level -
// у BlockRightClickedEventJS нет собственного getLevel(), только у вложенного block.
BlockEvents.rightClicked(event => {
	if (!BRIDGED_GENERATORS.includes(event.block.id)) return
	registerBridgeSource(event.block.level, event.block.pos)
})

// ВАЖНО: внутри этого обработчика используем var, а не const/let, для всех переменных,
// объявленных в теле циклов. Rhino (движок KubeJS) переиспользует скомпилированную область
// видимости между последовательными вызовами ServerEvents.tick, и const/let в теле цикла
// внутри функции, вызываемой каждый тик, падает с "TypeError: redeclaration of var X" уже
// на втором тике - именно поэтому мост раньше не работал вообще (тик валился с ошибкой).
ServerEvents.tick(event => {
	for (const key in global.TFG_FE_BRIDGE_SOURCES) {
		var info = global.TFG_FE_BRIDGE_SOURCES[key]
		var level = info.level
		var pos = info.pos

		try {
			if (!level.isLoaded(pos)) continue

			var sourceBE = level.getBlockEntity(pos)
			if (!sourceBE) {
				unregisterBridgeSource(pos)
				continue
			}

			var feOpt = sourceBE.getCapability(ForgeCapabilities.ENERGY, null)
			if (!feOpt.isPresent()) continue
			var feStorage = feOpt.resolve().get()

			for (var i = 0; i < DIRECTIONS.length; i++) {
				var dir = DIRECTIONS[i]

				// сколько FE вообще готов отдать источник прямо сейчас (симуляция)
				var feAvailable = feStorage.extractEnergy(2147483647, true)
				if (feAvailable <= 0) break // на этот тик источник исчерпан, дальше по сторонам смысла нет

				var neighborPos = pos.relative(dir)
				if (!level.isLoaded(neighborPos)) continue
				var neighborBE = level.getBlockEntity(neighborPos)
				if (!neighborBE) continue

				var gtOpt = neighborBE.getCapability(GTCapability.CAPABILITY_ENERGY_CONTAINER, dir.getOpposite())
				if (!gtOpt.isPresent()) continue
				var container = gtOpt.resolve().get()

				var euOffered = FeCompat.toEu(feAvailable, FeCompat.ratio(FE_TO_EU_RATIO))
				if (euOffered <= 0) continue

				var euRoom = container.getEnergyCanBeInserted()
				if (euRoom <= 0) continue
				if (euOffered > euRoom) euOffered = euRoom

				var euAccepted = container.changeEnergy(euOffered)
				if (euAccepted <= 0) continue

				var feToRemove = FeCompat.toFeLong(euAccepted, FeCompat.ratio(FE_TO_EU_RATIO))
				if (feToRemove > 0) feStorage.extractEnergy(feToRemove, false)
			}
		} catch (e) {
			// не роняем весь тик из-за одного сломанного/выгруженного источника
			unregisterBridgeSource(pos)
		}
	}
})

// priority: 0
"use strict";

/**
 * СВОИ ЧЕРТЫ ЕДЫ для механики заморозки в погребах.
 *
 * ПОЧЕМУ ИМЕННО STARTUP-СКРИПТ, а не серверный: startup выполняется и на
 * сервере, и на клиенте, а server_scripts в мультиплеере крутятся только на
 * сервере. Черта, зарегистрированная лишь на сервере, приедет клиенту в NBT
 * еды как неизвестный идентификатор - и тултип её не покажет.
 * Поэтому регистрация здесь, а вся логика охлаждения - в
 * server_scripts/tfg/cellar_freezing.js.
 *
 * Множитель черты - во сколько раз БЫСТРЕЕ портится еда: 1.0 обычно,
 * 0.0 останавливает порчу полностью. Это штатный механизм TFC, тот же, что у
 * Salted/Brined/Preserved (см. traitPreservedModifier в tfc-server.toml).
 */

const FT_ItemStackClass = Java.loadClass("net.minecraft.world.item.ItemStack")
const FT_ResourceLocationClass = Java.loadClass("net.minecraft.resources.ResourceLocation")
const FT_FloatClass = Java.loadClass("java.lang.Float")

/**
 * Class-объекты берём через загрузчик живого экземпляра: Java.loadClass отдаёт
 * NativeJavaClass, у которого методов java.lang.Class (getConstructor, getMethod)
 * попросту нет.
 */
const FT_Loader = FT_ItemStackClass.EMPTY.getClass().getClassLoader()
const FT_TraitCls = FT_Loader.loadClass("net.dries007.tfc.common.capabilities.food.FoodTrait")
const FT_StringCls = FT_Loader.loadClass("java.lang.String")

/**
 * Рефлексия обязательна: у FoodTrait два конструктора с одинаковым числом
 * аргументов - (float, String) и (Supplier<Float>, String). Обычный вызов из
 * скрипта выбрал бы наугад.
 */
const FT_Ctor = FT_TraitCls.getConstructor(FT_FloatClass.TYPE, FT_StringCls)
const FT_Register = FT_TraitCls.getMethod("register",
	FT_Loader.loadClass("net.minecraft.resources.ResourceLocation"), FT_TraitCls)

/** Float.valueOf(<JS-число>) уходит в valueOf(String) и падает - даём строку сами. */
function ftFloat(n) { return FT_FloatClass.valueOf(String(n)) }

/** Ступени охлаждения. Пороги температуры живут в cellar_freezing.js. */
const TFG_FOOD_TIERS = [
	{ id: 'tfg:frozen_solid', modifier: 0.0, maxTemp: -20, name: 'Заморожено' },
	{ id: 'tfg:deep_chilled', modifier: 0.2, maxTemp: -10, name: 'Сильно охлаждено' },
	{ id: 'tfg:chilled', modifier: 0.5, maxTemp: 0, name: 'Охлаждено' },
]

global.TFG_FOOD_TRAITS = null
try {
	global.TFG_FOOD_TRAITS = TFG_FOOD_TIERS.map(t => {
		var path = t.id.split(':')[1]
		var trait = FT_Ctor.newInstance(ftFloat(t.modifier), 'tfg.food_trait.' + path)
		var registered = FT_Register.invoke(null, new FT_ResourceLocationClass('tfg', path), trait)
		return { def: t, trait: registered || trait }
	})
	console.log(`[tfg food_traits] зарегистрировано черт: ${global.TFG_FOOD_TRAITS.length}`)
} catch (e) {
	console.error(`[tfg food_traits][ОШИБКА] регистрация не удалась: ${e}` + (e.stack ? "\n" + e.stack : ""))
}

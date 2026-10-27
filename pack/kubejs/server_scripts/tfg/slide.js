// priority: 0
"use strict";

/**
 * ПОДКАТ: лечь на бегу -> рывок вперёд, а не остановка.
 *
 * Приём "лечь" даёт мод GoProne (клавиша C, та же, что у tacz.crawl). Он не
 * отменяет спринт (в defaultconfigs/goprone-server.toml isSprintingAllowed=true),
 * но скорость ползания низкая, поэтому на бегу приём только мешал.
 *
 * КАК ОПРЕДЕЛЯЕМ, ЧТО ИГРОК ЛЁГ: GoProne выставляет принудительную позу
 * Pose.SWIMMING (разобрано по байткоду PlayerProneData.updateProneState -
 * IPronePlatform.setForcedPose(player, Pose.SWIMMING)). Поза синхронизируется,
 * так что с сервера она читается обычным getPose(). От настоящего плавания
 * отличаем по isInWater().
 *
 * КАК ТОЛКАЕМ: одиночный импульс скорости в момент перехода плюс временный
 * модификатор скорости передвижения на время подката. Импульс сам по себе
 * гасится трением почти мгновенно, а модификатор не даёт ползанию сразу
 * съесть темп - вместе получается именно проезд, а не прыжок.
 *
 * Игроку скорость с сервера надо ещё и ДОСЛАТЬ: setDeltaMovement на серверной
 * стороне сам по себе клиенту не виден, движение игрока клиент-авторитетно.
 * Поэтому hurtMarked = true - тот же механизм, которым синхронизируется отдача
 * от удара. Имя поля отрабатывает ремаппер KubeJS (MinecraftRemapper.
 * getMappedField), так что писать SRG-имя руками не нужно.
 *
 * Файл самодостаточный: ничего подключать в main_server_script.js не надо.
 */

/**
 * ВЫКЛЮЧЕНО: подкат теперь делает ParCool (действие Slide, "do Crawl while
 * doing Fast Run" - дословно наш триггер, но со своей анимацией).
 *
 * Свой подкат оставлен в файле, а не удалён: если ParCool не приживётся
 * (он лезет в те же PlayerModelMixin/PlayerRendererMixin/LivingRendererMixin,
 * что и NotEnoughAnimations - на этом уже сломался PlayerAnimator), достаточно
 * вернуть true, и рывок с разворотом корпуса заработают снова.
 *
 * Держать оба включёнными нельзя - два подката будут драться за скорость.
 */
const SLIDE_ENABLED = false

const SLIDE_PoseClass = Java.loadClass("net.minecraft.world.entity.Pose")
const SLIDE_POSE_PRONE = String(SLIDE_PoseClass.SWIMMING)

// Math.PI в этом Rhino на практике оказывался NaN - держим литералом
const SLIDE_PI = 3.141592653589793

const SLIDE_IMPULSE = 0.62          // сила рывка (блоков/тик)
const SLIDE_SPEED_BONUS = 1.6       // множитель скорости на время подката
const SLIDE_TICKS = 14              // сколько длится подкат
const SLIDE_COOLDOWN_TICKS = 40     // пауза между подкатами, чтобы не спамить
const SLIDE_ATTR = 'minecraft:generic.movement_speed'
const SLIDE_MODIFIER = 'tfg_slide'

/**
 * Разворот корпуса ногами вперёд на время подката.
 *
 * Настоящую анимацию подката сделать нечем: в сборке нет мода, умеющего играть
 * произвольные анимации игрока (GeckoLib анимирует мобов модов, а не игрока;
 * NotEnoughAnimations чисто клиентский, с жёстко зашитым набором и без всякого
 * API). А KubeJS - сервер, анимация же целиком на клиенте.
 *
 * Что с сервера ДО клиента всё-таки доходит - поза и поворот корпуса. В лёжке
 * (Pose.SWIMMING) игрок рисуется горизонтально ВДОЛЬ поворота корпуса, поэтому
 * разворот корпуса на 180° кладёт тело ногами по ходу движения, а голова при
 * этом остаётся смотреть куда смотрела.
 *
 * ЧЕСТНОЕ ОГРАНИЧЕНИЕ: поворот корпуса своего игрока клиент считает сам, и
 * серверное значение он каждый тик перетирает. Поэтому эффект надёжно виден
 * ДРУГИМ игрокам, а себе - в лучшем случае частично и с дёрганьем. В одиночной
 * игре смысла почти нет. Ставь false, если не нравится.
 */
const SLIDE_FEET_FIRST = true

/**
 * НАСТОЯЩАЯ АНИМАЦИЯ ПОДКАТА (Emotecraft + PlayerAnimator).
 *
 * Ванильных средств анимировать игрока нет вообще: поза берётся из фиксированного
 * перечисления Pose, а гнёт модель PlayerRenderer по зашитым правилам. Поэтому
 * нужен клиентский мод. PlayerAnimator - стандартная библиотека для этого, но она
 * клиентская: в её README прямо сказано, что для запуска анимаций С СЕРВЕРА нужен
 * либо свой сетевой пакет, либо серверный API Emotecraft.
 *
 * У Emotecraft он есть, и это статические методы - значит доступны из KubeJS
 * (проверено javap по установленному джарнику 2.2.7-b.build.50):
 *     ServerEmoteAPI.getEmote(UUID) -> KeyframeAnimation
 *     ServerEmoteAPI.playEmote(UUID игрока, KeyframeAnimation, boolean forced)
 * Обе перегрузок не имеют, так что ловушка выбора перегрузки тут не грозит.
 *
 * Сама анимация лежит в emotes/tfg_slide.json (формат Emotecraft, разобран по
 * встроенным эмоциям мода). UUID зашит в файле, поэтому ищем по нему, а не по имени.
 *
 * Всё в try: если Emotecraft не установлен, подкат просто работает без анимации,
 * и комплект остаётся переносимым.
 */
const SLIDE_EMOTE_UUID_STR = '7f9c1a20-5d3e-4b71-9c84-a1b2c3d4e5f6'
var SLIDE_EmoteAPI = null
var SLIDE_EmoteUUID = null
try {
	SLIDE_EmoteAPI = Java.loadClass('io.github.kosmx.emotes.api.events.server.ServerEmoteAPI')
	SLIDE_EmoteUUID = Java.loadClass('java.util.UUID').fromString(SLIDE_EMOTE_UUID_STR)
} catch (e) {
	global.tfgLog('tfg slide', 'Emotecraft не найден - подкат будет без анимации: ' + e)
}

var SLIDE_STATE = {}  // uuid -> { prone, sprinting, left, cd, boosted }

function slideLog(msg) {
	global.tfgLog("tfg slide", msg)
}

function slideIsProne(player) {
	try {
		if (String(player.getPose()) !== SLIDE_POSE_PRONE) return false
		return !player.isInWater() // настоящее плавание использует ту же позу
	} catch (e) {
		return false
	}
}

/** onGround() в 1.20.1 переименован - пробуем оба имени, чтобы не гадать. */
function slideOnGround(player) {
	try {
		if (typeof player.onGround === 'function') return player.onGround() === true
		if (typeof player.isOnGround === 'function') return player.isOnGround() === true
	} catch (e) { /* ниже */ }
	return true // не смогли определить - не мешаем приёму
}

/**
 * Кладёт корпус ногами по ходу движения. yBodyRotO (значение прошлого тика)
 * ставим тем же числом - иначе клиент интерполирует поворот и корпус
 * прокручивается через пол-оборота вместо мгновенного разворота.
 */
function slideFaceFeetFirst(player) {
	if (!SLIDE_FEET_FIRST) return
	try {
		var back = player.getYRot() + 180
		player.setYBodyRot(back)
		player.yBodyRotO = back
	} catch (e) {
		// один раз хватит: если метода нет, он не появится
		if (!slideFaceFeetFirst.warned) {
			slideFaceFeetFirst.warned = true
			slideLog("разворот корпуса недоступен: " + e)
		}
	}
}

/** Просит Emotecraft проиграть подкат этому игроку у всех клиентов вокруг. */
var slideEmoteWarned = false
function slidePlayEmote(player) {
	if (!SLIDE_EmoteAPI || !SLIDE_EmoteUUID) return
	try {
		var anim = SLIDE_EmoteAPI.getEmote(SLIDE_EmoteUUID)
		if (!anim) {
			if (!slideEmoteWarned) {
				slideEmoteWarned = true
				slideLog('эмоция ' + SLIDE_EMOTE_UUID_STR + ' не загружена - лежит ли emotes/tfg_slide.json и включён ли loadEmotesServerSide в конфиге Emotecraft?')
			}
			return
		}
		// forced=true - чтобы анимацию не сбило обычным вводом игрока
		SLIDE_EmoteAPI.playEmote(player.uuid, anim, true)
	} catch (e) {
		if (!slideEmoteWarned) {
			slideEmoteWarned = true
			slideLog('не удалось проиграть анимацию: ' + e)
		}
	}
}

function slideStop(player, st) {
	if (st.boosted) {
		try {
			player.removeAttribute(SLIDE_ATTR, SLIDE_MODIFIER)
		} catch (e) {
			slideLog("не удалось снять модификатор скорости: " + e)
		}
		st.boosted = false
	}
	st.left = 0
}

function slideStart(player, st) {
	try {
		// направление взгляда по горизонтали: forward = (-sin(yaw), 0, cos(yaw))
		var yawRad = player.getYRot() * SLIDE_PI / 180
		var fx = -Math.sin(yawRad)
		var fz = Math.cos(yawRad)
		if (isNaN(fx) || isNaN(fz)) {
			slideLog("направление получилось NaN - подкат отменён")
			return
		}

		// через собственные геттеры KubeJS (kjs$getMotionX и т.п.), а не через поля
		// Vec3 - меньше зависимости от ремаппинга имён полей
		player.setMotionX(player.getMotionX() + fx * SLIDE_IMPULSE)
		player.setMotionZ(player.getMotionZ() + fz * SLIDE_IMPULSE)
		// без этого серверная скорость до клиента не доедет: движение игрока
		// клиент-авторитетно, hurtMarked заставляет сервер дослать пакет скорости
		player.hurtMarked = true

		player.modifyAttribute(SLIDE_ATTR, SLIDE_MODIFIER, SLIDE_SPEED_BONUS, 'multiply_total')
		st.boosted = true
		slidePlayEmote(player)
		st.left = SLIDE_TICKS
		st.cd = SLIDE_COOLDOWN_TICKS

		slideLog(player.username + ": подкат (yaw=" + Math.round(player.getYRot()) + ")")
	} catch (e) {
		global.tfgLogError("tfg slide", player.username, e)
		slideStop(player, st)
	}
}

ServerEvents.tick(event => {
	if (!SLIDE_ENABLED) return
	event.server.players.forEach(player => {
		try {
			var key = String(player.uuid)
			var st = SLIDE_STATE[key]
			if (!st) {
				st = { prone: false, sprinting: false, left: 0, cd: 0, boosted: false }
				SLIDE_STATE[key] = st
			}

			if (st.cd > 0) st.cd--

			var prone = slideIsProne(player)
			var sprinting = player.isSprinting()

			if (st.left > 0) {
				st.left--
				slideFaceFeetFirst(player)
				// встал раньше времени - подкат кончился
				if (!prone || st.left === 0) slideStop(player, st)
			} else if (
				prone && !st.prone &&              // именно момент перехода в лёжку
				(sprinting || st.sprinting) &&     // на бегу (GoProne может снять флаг в тот же тик)
				st.cd === 0 &&
				slideOnGround(player) &&
				!player.isInWater()
			) {
				slideStart(player, st)
			}

			st.prone = prone
			st.sprinting = sprinting
		} catch (e) {
			global.tfgLogError("tfg slide", "тик для " + player.username, e)
		}
	})
})

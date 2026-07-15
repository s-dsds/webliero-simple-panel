let auth = new Map();
let conn = new Map(); // player id -> hex-encoded connection IP (moderation autokick)
var fdb;

// Reverse lookup: auth-id -> current player id (auth Map is id -> auth).
// Ported from buildinggame/_init.js; upstream webliero-simple referenced it
// in removeAdmin (firebase.js) but never defined it, so !deladmin on an
// online target threw a ReferenceError.
function getPlayerIdFromAuth(a) {
    for (const [k, p] of auth) {
        if (p == a) {
            return k
        }
    }
    return null
}

var commentsRef;
var notifsRef;

var commands;

const chainFunction = (object, attribute, func) => {
    const original = object[attribute]
    if (original) {
      object[attribute] = (...arguments) => {
        let or = original.apply(object, arguments)
        let r = func.apply(object, arguments)
        if (false==r || false==or) {
          return false;
        }
      }
    } else {
      object[attribute] = func
    }
}

(async function () {
	console.log("Running Server...");
	var room = WLInit({
		token: window.WLTOKEN,
		roomName: CONFIG.room_name,
		maxPlayers: CONFIG.max_players,	
		public: CONFIG.public
	});

	room.setSettings({
		scoreLimit: 10,
		timeLimit: 10,
		gameMode: "dm",
		levelPool: "arenasBest",
		respawnDelay: 3,
		bonusDrops: "health",
		teamsLocked: false,
	});
	window.WLROOM = room;

	room.onRoomLink = (link) => console.log(link);
	room.onCaptcha = () => console.log("Invalid token");
})();
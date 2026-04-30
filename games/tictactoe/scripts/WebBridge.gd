extends Node
class_name WebBridge

# Godot HTML5 bridge for an outer "shell" page.
# Uses a versioned envelope so multiple games can share one transport:
#   { bfg: true, v: 1, game: "<gameType>", type: "<event>", payload: "<json>" }

signal message(type: String, payload: Variant)

var _window: JavaScriptObject
var _cb: JavaScriptObject
const _GAME: String = "tictactoe"
const _V: int = 1
const _DEBUG_QUERY_KEY: String = "debug"

func _ready() -> void:
	if OS.get_name() != "Web":
		return

	_window = JavaScriptBridge.get_interface("window")
	if _window == null:
		return

	_cb = JavaScriptBridge.create_callback(_on_js_message)
	_listen_for_messages()

	# Tell the parent we're alive.
	send("godot_ready", { "exportVersion": "4.6.2", "capabilities": ["state_init", "state_public", "intent"] })

func _listen_for_messages() -> void:
	if _window == null:
		return
	# Use `call()` because strict typing can't prove Window has addEventListener().
	# (Direct `_window.addEventListener(...)` triggers "method not present" errors.)
	_window.call("addEventListener", "message", _cb)

func send(type: String, payload: Variant) -> void:
	if OS.get_name() != "Web":
		return

	var encoded := JSON.stringify(payload)
	var envelope: Dictionary = {
		"bfg": true,
		"v": _V,
		"game": _GAME,
		"type": type,
		"payload": encoded,
	}
	# Serialize the whole envelope to JSON and use eval() so the JS engine parses
	# it as a native object (passing Dictionaries as JS args is unreliable).
	var envelope_json := JSON.stringify(envelope)
	JavaScriptBridge.eval("parent.postMessage(%s, '*')" % [envelope_json], true)

func _exit_tree() -> void:
	if OS.get_name() != "Web":
		return
	if _window != null and _cb != null:
		_window.call("removeEventListener", "message", _cb)

func _on_js_message(args: Array) -> void:
	# JS calls the callback with one argument: the MessageEvent.
	if args.size() < 1:
		return
	var ev: Variant = args[0]
	if ev == null:
		return

	# `ev.data` is a plain JS object; subscript access works, .get/.has do not.
	var data: Variant = ev["data"]
	if data == null:
		return
	var bfgv: Variant = data["bfg"]
	if bfgv == null:
		return
	if typeof(bfgv) != TYPE_BOOL and typeof(bfgv) != TYPE_INT:
		return
	var bfg: bool = false
	if typeof(bfgv) == TYPE_BOOL:
		bfg = bfgv
	else:
		var bfg_i: int = bfgv
		bfg = bfg_i != 0
	if not bfg:
		return
	var vv: Variant = data["v"]
	if vv == null:
		return
	if typeof(vv) != TYPE_INT and typeof(vv) != TYPE_BOOL and typeof(vv) != TYPE_FLOAT:
		return
	var v_int: int = vv
	if v_int != _V:
		return
	var gv: Variant = data["game"]
	if gv == null:
		return
	if typeof(gv) != TYPE_STRING and typeof(gv) != TYPE_STRING_NAME and typeof(gv) != TYPE_NODE_PATH:
		return
	var game: String = gv
	if game != _GAME:
		return

	var tv: Variant = data["type"]
	if tv == null:
		return
	if typeof(tv) != TYPE_STRING and typeof(tv) != TYPE_STRING_NAME and typeof(tv) != TYPE_NODE_PATH:
		return
	var t: String = tv
	if t == "":
		return

	var raw_payload: Variant = data["payload"]
	var p: Variant = null
	if raw_payload != null:
		if typeof(raw_payload) != TYPE_STRING and typeof(raw_payload) != TYPE_STRING_NAME and typeof(raw_payload) != TYPE_NODE_PATH:
			return
		var s: String = raw_payload
		if s != "":
			var parsed: Variant = JSON.parse_string(s)
			if parsed != null:
				p = parsed
	emit_signal("message", t, p)

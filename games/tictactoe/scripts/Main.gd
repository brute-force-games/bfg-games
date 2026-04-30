extends Control

@onready var bridge: WebBridge = $WebBridge

# Keep untyped Arrays here: JSON.parse_string returns untyped `Array`, and
# assigning it into a typed Array can fail to update visuals (board stays
# at its previous value). We'll validate indices at usage sites instead.
var board: Array = [null, null, null, null, null, null, null, null, null]
var current_player_id: String = ""
var local_player_id: String = ""
var player_x: String = ""
var player_o: String = ""
var winner_id: String = ""
var is_draw: bool = false
var symbol_by_mark := { "X": "X", "O": "O" }
var symbol_pair: String = "xo"
var has_state: bool = false
var view_role: String = "" # 'player' | 'observer' (from state_init)

const LION_TEX = preload("res://assets/lion.png")
const LAMB_TEX = preload("res://assets/lamb.png")

var _cell_buttons: Array[Button] = []
var _cell_icon_boxes: Array[CenterContainer] = []
var _cell_icons: Array[TextureRect] = []
var _status_label: Label
var _subtitle_label: Label
var _role_label: Label
var _legend_left: Label
var _legend_right: Label

func _ready() -> void:
	_build_ui()
	if bridge:
		bridge.message.connect(_on_bridge_message)

func _build_ui() -> void:
	# Full-bleed layout so the board can fill the iframe area.
	var outer: MarginContainer = MarginContainer.new()
	outer.name = "Outer"
	outer.anchor_right = 1.0
	outer.anchor_bottom = 1.0
	outer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	outer.size_flags_vertical = Control.SIZE_EXPAND_FILL
	outer.add_theme_constant_override("margin_left", 18)
	outer.add_theme_constant_override("margin_right", 18)
	outer.add_theme_constant_override("margin_top", 18)
	outer.add_theme_constant_override("margin_bottom", 18)
	add_child(outer)

	# Card styling via a panel background that stretches.
	var panel: PanelContainer = PanelContainer.new()
	panel.name = "Panel"
	panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	panel.size_flags_vertical = Control.SIZE_EXPAND_FILL
	var sb: StyleBoxFlat = StyleBoxFlat.new()
	sb.bg_color = Color("#f7f4ed")
	sb.corner_radius_top_left = 14
	sb.corner_radius_top_right = 14
	sb.corner_radius_bottom_left = 14
	sb.corner_radius_bottom_right = 14
	sb.border_width_left = 1
	sb.border_width_right = 1
	sb.border_width_top = 1
	sb.border_width_bottom = 1
	sb.border_color = Color("#d6d0c3")
	panel.add_theme_stylebox_override("panel", sb)
	outer.add_child(panel)

	var inner_margin: MarginContainer = MarginContainer.new()
	inner_margin.name = "InnerMargin"
	inner_margin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	inner_margin.size_flags_vertical = Control.SIZE_EXPAND_FILL
	inner_margin.add_theme_constant_override("margin_left", 18)
	inner_margin.add_theme_constant_override("margin_right", 18)
	inner_margin.add_theme_constant_override("margin_top", 16)
	inner_margin.add_theme_constant_override("margin_bottom", 16)
	panel.add_child(inner_margin)

	var panel_inner: VBoxContainer = VBoxContainer.new()
	panel_inner.name = "PanelInner"
	panel_inner.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	panel_inner.size_flags_vertical = Control.SIZE_EXPAND_FILL
	panel_inner.add_theme_constant_override("separation", 10)
	inner_margin.add_child(panel_inner)

	# Header
	var title: Label = Label.new()
	title.text = "Tic Tac Toe"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", 28)
	title.add_theme_color_override("font_color", Color("#1b1b1b"))
	panel_inner.add_child(title)

	_subtitle_label = Label.new()
	_subtitle_label.text = ""
	_subtitle_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_subtitle_label.add_theme_font_size_override("font_size", 14)
	_subtitle_label.add_theme_color_override("font_color", Color("#6b6b6b"))
	panel_inner.add_child(_subtitle_label)

	_role_label = Label.new()
	_role_label.text = ""
	_role_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_role_label.add_theme_font_size_override("font_size", 13)
	_role_label.add_theme_color_override("font_color", Color("#4a4a4a"))
	panel_inner.add_child(_role_label)

	# Legend row (X vs O etc)
	var legend: HBoxContainer = HBoxContainer.new()
	legend.name = "Legend"
	legend.alignment = BoxContainer.ALIGNMENT_CENTER
	legend.add_theme_constant_override("separation", 10)
	panel_inner.add_child(legend)

	_legend_left = Label.new()
	_legend_left.text = "X"
	_legend_left.add_theme_font_size_override("font_size", 16)
	_legend_left.add_theme_color_override("font_color", Color("#1b1b1b"))
	legend.add_child(_legend_left)

	var vs: Label = Label.new()
	vs.text = "vs"
	vs.add_theme_font_size_override("font_size", 12)
	vs.add_theme_color_override("font_color", Color("#8a8a8a"))
	legend.add_child(vs)

	_legend_right = Label.new()
	_legend_right.text = "O"
	_legend_right.add_theme_font_size_override("font_size", 16)
	_legend_right.add_theme_color_override("font_color", Color("#1b1b1b"))
	legend.add_child(_legend_right)

	# Board container
	var board_wrap: VBoxContainer = VBoxContainer.new()
	board_wrap.name = "BoardWrap"
	board_wrap.custom_minimum_size = Vector2(0, 0)
	board_wrap.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	board_wrap.size_flags_vertical = Control.SIZE_EXPAND_FILL
	board_wrap.size_flags_stretch_ratio = 1.0
	board_wrap.alignment = BoxContainer.ALIGNMENT_CENTER
	panel_inner.add_child(board_wrap)

	# Keep the board square but allow it to fill the available area.
	var aspect: AspectRatioContainer = AspectRatioContainer.new()
	aspect.name = "BoardAspect"
	aspect.ratio = 1.0
	aspect.stretch_mode = AspectRatioContainer.STRETCH_FIT
	aspect.alignment_horizontal = AspectRatioContainer.ALIGNMENT_CENTER
	aspect.alignment_vertical = AspectRatioContainer.ALIGNMENT_CENTER
	aspect.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	aspect.size_flags_vertical = Control.SIZE_EXPAND_FILL
	board_wrap.add_child(aspect)

	var grid: GridContainer = GridContainer.new()
	grid.name = "Grid"
	grid.columns = 3
	grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	grid.size_flags_vertical = Control.SIZE_EXPAND_FILL
	grid.add_theme_constant_override("h_separation", 12)
	grid.add_theme_constant_override("v_separation", 12)
	aspect.add_child(grid)

	_cell_buttons = []
	_cell_icon_boxes = []
	_cell_icons = []
	for i in range(9):
		var b: Button = Button.new()
		b.name = "Cell%d" % i
		# Let the layout drive sizing so the board can scale to fill its area.
		b.custom_minimum_size = Vector2(0, 0)
		b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		b.size_flags_vertical = Control.SIZE_EXPAND_FILL
		b.add_theme_font_size_override("font_size", 28)
		b.focus_mode = Control.FOCUS_NONE
		b.clip_contents = true
		b.pressed.connect(Callable(self, "_on_cell_pressed").bind(i))

		var cell_sb: StyleBoxFlat = StyleBoxFlat.new()
		cell_sb.bg_color = Color("#f7f4ed")
		cell_sb.corner_radius_top_left = 14
		cell_sb.corner_radius_top_right = 14
		cell_sb.corner_radius_bottom_left = 14
		cell_sb.corner_radius_bottom_right = 14
		cell_sb.border_width_left = 2
		cell_sb.border_width_right = 2
		cell_sb.border_width_top = 2
		cell_sb.border_width_bottom = 2
		cell_sb.border_color = Color("#222222")
		b.add_theme_stylebox_override("normal", cell_sb)
		b.add_theme_stylebox_override("hover", cell_sb)
		b.add_theme_stylebox_override("pressed", cell_sb)
		b.add_theme_stylebox_override("disabled", cell_sb)

		# Icon layer (used by lion_lamb): center + clip reliably.
		var icon_box: CenterContainer = CenterContainer.new()
		icon_box.name = "IconBox"
		icon_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
		icon_box.set_anchors_preset(Control.PRESET_FULL_RECT)
		icon_box.offset_left = 14
		icon_box.offset_top = 14
		icon_box.offset_right = -14
		icon_box.offset_bottom = -14
		icon_box.visible = false
		b.add_child(icon_box)

		var icon: TextureRect = TextureRect.new()
		icon.name = "Icon"
		icon.mouse_filter = Control.MOUSE_FILTER_IGNORE
		icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		icon.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		icon.size_flags_vertical = Control.SIZE_EXPAND_FILL
		icon_box.add_child(icon)

		grid.add_child(b)
		_cell_buttons.append(b)
		_cell_icon_boxes.append(icon_box)
		_cell_icons.append(icon)

	# Status pill
	var pill_wrap: HBoxContainer = HBoxContainer.new()
	pill_wrap.name = "PillWrap"
	pill_wrap.alignment = BoxContainer.ALIGNMENT_CENTER
	pill_wrap.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	panel_inner.add_child(pill_wrap)

	var pill: PanelContainer = PanelContainer.new()
	var pill_sb: StyleBoxFlat = StyleBoxFlat.new()
	pill_sb.bg_color = Color("#eef0f3")
	pill_sb.corner_radius_top_left = 10
	pill_sb.corner_radius_top_right = 10
	pill_sb.corner_radius_bottom_left = 10
	pill_sb.corner_radius_bottom_right = 10
	pill.add_theme_stylebox_override("panel", pill_sb)
	pill_wrap.add_child(pill)

	var pill_inner: MarginContainer = MarginContainer.new()
	pill_inner.add_theme_constant_override("margin_left", 14)
	pill_inner.add_theme_constant_override("margin_right", 14)
	pill_inner.add_theme_constant_override("margin_top", 8)
	pill_inner.add_theme_constant_override("margin_bottom", 8)
	pill.add_child(pill_inner)

	_status_label = Label.new()
	_status_label.text = "Waiting for state…"
	_status_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_status_label.add_theme_font_size_override("font_size", 14)
	_status_label.add_theme_color_override("font_color", Color("#3b3b3b"))
	pill_inner.add_child(_status_label)

	_render()

func _render() -> void:
	if not has_state:
		_status_label.text = "Waiting for state…"
		_status_label.add_theme_color_override("font_color", Color("#3b3b3b"))
	elif winner_id != "":
		_status_label.text = _winner_display()
		if symbol_pair == "lion_lamb":
			var wm: String = "X" if winner_id == player_x else "O"
			_status_label.add_theme_color_override("font_color", Color("#c4860e") if wm == "X" else Color("#4a6a90"))
		elif symbol_pair == "red_blue":
			var wm: String = "X" if winner_id == player_x else "O"
			_status_label.add_theme_color_override("font_color", Color("#d54b3f") if wm == "X" else Color("#3b6fb6"))
		else:
			_status_label.add_theme_color_override("font_color", Color("#e05c40"))
	elif is_draw:
		_status_label.text = "Draw 🤝"
		_status_label.add_theme_color_override("font_color", Color("#3b3b3b"))
	elif current_player_id != "":
		var you_suffix: String = " (you)" if current_player_id == local_player_id else ""
		_status_label.text = "%s's turn%s" % [_player_display(current_player_id), you_suffix]
		_status_label.add_theme_color_override("font_color", Color("#3b3b3b"))
	else:
		_status_label.text = "Waiting for players…"
		_status_label.add_theme_color_override("font_color", Color("#3b3b3b"))

	for i in range(9):
		var cell_btn: Button = _cell_buttons[i]
		var v: Variant = board[i]
		_apply_cell_visual(i, cell_btn, v)

		var my_mark: String = "X" if local_player_id == player_x else ("O" if local_player_id == player_o else "")
		var is_my_turn: bool = current_player_id != "" and current_player_id == local_player_id
		var disabled: bool = (v != null) or (winner_id != "") or is_draw or (not is_my_turn) or (my_mark == "")
		cell_btn.disabled = disabled

func _on_cell_pressed(cell_index: int) -> void:
	if bridge:
		bridge.send("intent", { "kind": "tictactoe/move", "cellIndex": cell_index })

func _on_bridge_message(type: String, payload: Variant) -> void:
	# Enveloped bridge payloads:
	# - state_init: { localPlayerId, view, publicState: { ... }, symbolByMark? }
	# - state_public: { publicState: { ... } }
	# - intent: { kind, ... } (sent by Godot; received by web)
	if type == "state_init":
		if payload == null:
			return
		if typeof(payload) != TYPE_DICTIONARY:
			return
		var d: Dictionary = payload
		var init: Dictionary = _validate_state_init(d)
		if init.is_empty():
			return
		local_player_id = init["localPlayerId"]
		view_role = init["view"]
		symbol_pair = init["symbolPair"]
		symbol_by_mark = init["symbolByMark"]
		_apply_public_state(init["publicState"])
	elif type == "state_public":
		if payload == null:
			return
		if typeof(payload) != TYPE_DICTIONARY:
			return
		var d: Dictionary = payload
		var pub: Dictionary = _validate_state_public(d)
		if pub.is_empty():
			return
		_apply_public_state(pub["publicState"])

func _validate_state_init(d: Dictionary) -> Dictionary:
	# Returns a normalized payload Dictionary, or {} if invalid.
	var out: Dictionary = {}

	var lpid_v: Variant = d.get("localPlayerId", "")
	if typeof(lpid_v) != TYPE_STRING:
		return out
	var lpid: String = lpid_v

	var view_v: Variant = d.get("view", "")
	if typeof(view_v) != TYPE_STRING:
		return out
	var view: String = view_v

	var symbol_pair_v: Variant = d.get("symbolPair", "xo")
	if typeof(symbol_pair_v) != TYPE_STRING:
		return out
	var sp: String = symbol_pair_v

	var sbm: Dictionary = { "X": "X", "O": "O" }
	var sbm_v: Variant = d.get("symbolByMark", null)
	if sbm_v != null and typeof(sbm_v) == TYPE_DICTIONARY:
		sbm = sbm_v

	var ps_v: Variant = d.get("publicState", null)
	if ps_v == null or typeof(ps_v) != TYPE_DICTIONARY:
		return out
	var ps: Dictionary = ps_v

	out["localPlayerId"] = lpid
	out["view"] = view
	out["symbolPair"] = sp
	out["symbolByMark"] = sbm
	out["publicState"] = ps
	return out

func _validate_state_public(d: Dictionary) -> Dictionary:
	var out: Dictionary = {}
	var ps_v: Variant = d.get("publicState", null)
	if ps_v == null or typeof(ps_v) != TYPE_DICTIONARY:
		return out
	out["publicState"] = ps_v
	return out

func _apply_public_state(public_state: Variant) -> void:
	if public_state == null:
		return
	if typeof(public_state) != TYPE_DICTIONARY:
		return
	var ps: Dictionary = public_state
	has_state = true
	var next_board_v: Variant = ps.get("board", board)
	# Ensure we have a plain Array so indexing works reliably.
	if next_board_v is Array:
		var next_board: Array = next_board_v
		board = next_board.duplicate(true)
	var cpid: Variant = ps.get("currentPlayerId", null)
	current_player_id = "" if cpid == null else str(cpid)
	player_x = str(ps.get("playerX", ""))
	player_o = str(ps.get("playerO", ""))
	var wid: Variant = ps.get("winnerId", null)
	winner_id = "" if wid == null else str(wid)
	is_draw = ps.get("isDraw", false) == true
	_update_header()
	_render()

func _update_header() -> void:
	if symbol_pair == "lion_lamb":
		_legend_left.text = "🦁 Lion"
		_legend_right.text = "🐑 Lamb"
		_subtitle_label.text = "Lion vs. Lamb • wild edition"
		_legend_left.add_theme_color_override("font_color", Color("#c4860e"))
	elif symbol_pair == "red_blue":
		_legend_left.text = "Red"
		_legend_right.text = "Blue"
		_subtitle_label.text = "Red vs. Blue • color battle"
		_legend_left.add_theme_color_override("font_color", Color("#d54b3f"))
		_legend_right.add_theme_color_override("font_color", Color("#3b6fb6"))
	else:
		_legend_left.text = "X"
		_legend_right.text = "O"
		_subtitle_label.text = "X vs. O • classic"
		_legend_left.add_theme_color_override("font_color", Color("#1b1b1b"))
		_legend_right.add_theme_color_override("font_color", Color("#1b1b1b"))

	var you_mark: String = ""
	if local_player_id != "":
		if local_player_id == player_x:
			you_mark = "X"
		elif local_player_id == player_o:
			you_mark = "O"
	if view_role == "observer" or (you_mark == "" and has_state):
		_role_label.text = "You are observing"
	elif you_mark != "":
		_role_label.text = "You are %s" % str(symbol_by_mark.get(you_mark, you_mark))
	else:
		_role_label.text = ""

func _apply_cell_visual(idx: int, btn: Button, cell_value: Variant) -> void:
	var icon_box: CenterContainer = _cell_icon_boxes[idx]
	var icon: TextureRect = _cell_icons[idx]
	if cell_value == null:
		btn.text = ""
		icon.texture = null
		icon_box.visible = false
		btn.add_theme_font_size_override("font_size", 28)
		_set_cell_style(btn, Color("#f7f4ed"), 14)
		return

	var mark: String = str(cell_value)

	if symbol_pair == "lion_lamb":
		var bg: Color = Color("#f0b030") if mark == "X" else Color("#b8cfe4")
		btn.text = ""
		icon.texture = LION_TEX if mark == "X" else LAMB_TEX
		icon_box.visible = true
		btn.add_theme_font_size_override("font_size", 28)
		_set_cell_style(btn, bg, 999)
	elif symbol_pair == "red_blue":
		var bg: Color = Color("#c45c52") if mark == "X" else Color("#4e74b9")
		btn.text = ""
		icon.texture = null
		icon_box.visible = false
		btn.add_theme_font_size_override("font_size", 28)
		_set_cell_style(btn, bg, 14)
	else:
		btn.text = str(symbol_by_mark.get(mark, mark))
		icon.texture = null
		icon_box.visible = false
		btn.add_theme_font_size_override("font_size", 28)
		_set_cell_style(btn, Color("#f7f4ed"), 14)

func _set_cell_style(btn: Button, bg: Color, radius: int) -> void:
	var sb: StyleBoxFlat = StyleBoxFlat.new()
	sb.bg_color = bg
	sb.corner_radius_top_left = radius
	sb.corner_radius_top_right = radius
	sb.corner_radius_bottom_left = radius
	sb.corner_radius_bottom_right = radius
	# Keep border only for XO mode (radius == 14); circles and squares look
	# better without a border in lion_lamb and red_blue modes.
	if radius == 14:
		sb.border_width_left = 2
		sb.border_width_right = 2
		sb.border_width_top = 2
		sb.border_width_bottom = 2
		sb.border_color = Color("#222222")
	btn.add_theme_stylebox_override("normal", sb)
	btn.add_theme_stylebox_override("hover", sb)
	btn.add_theme_stylebox_override("pressed", sb)
	btn.add_theme_stylebox_override("disabled", sb)

func _player_display(player_id: String) -> String:
	var mark: String = ""
	if player_id == player_x:
		mark = "X"
	elif player_id == player_o:
		mark = "O"
	else:
		return player_id
	if symbol_pair == "lion_lamb":
		return ("🦁 Lion" if mark == "X" else "🐑 Lamb")
	return str(symbol_by_mark.get(mark, mark))

func _winner_display() -> String:
	if symbol_pair == "lion_lamb":
		var mark: String = "X" if winner_id == player_x else "O"
		return ("🦁 Lion wins! Roar!" if mark == "X" else "🐑 Lamb wins! Baa!")
	return "%s wins!" % _player_display(winner_id)

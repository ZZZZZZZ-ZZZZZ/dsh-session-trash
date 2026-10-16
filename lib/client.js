window.__ModuleLoader__.load({
	id: "dsh-plugin-session-trash",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/protocol.ts
		/** Typert namespace and Cordis service key of the trash service. */
		const SESSION_TRASH_NAMESPACE = "sessionTrash";
		/** npm package that owns the Remote methods. */
		const SESSION_TRASH_PACKAGE = "dsh-plugin-session-trash";
		function strict(typeSymbol, parse) {
			const schema = { parse };
			return {
				mode: "strict",
				typeSymbol,
				create: () => schema
			};
		}
		function record(value, what) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object`);
			return value;
		}
		function exactKeys(value, required, optional, what) {
			for (const key of required) if (!(key in value)) throw new TypeError(`${what}.${key} is required`);
			for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new TypeError(`${what}.${key} is not allowed`);
		}
		function text(value, what, maxLength) {
			if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new TypeError(`${what} must be a non-empty string of at most ${String(maxLength)} characters`);
			return value;
		}
		const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		function uuid(value, what) {
			if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${what} must be a lowercase UUID`);
			return value;
		}
		/**
		* Validate a trash entry id: a lowercase UUID, so it can never name a path
		* outside the trash directory.
		* @param value - untrusted value.
		* @returns the entry id.
		*/
		function parseEntryId(value) {
			return uuid(value, "entryId");
		}
		function parseMoveRequest(value) {
			const body = record(value, "request");
			exactKeys(body, ["sessionId", "title"], [], "request");
			return {
				sessionId: text(body.sessionId, "request.sessionId", 512),
				title: text(body.title, "request.title", 1e3)
			};
		}
		function parseEntryRequest(value) {
			const body = record(value, "request");
			exactKeys(body, ["entryId"], [], "request");
			return { entryId: parseEntryId(body.entryId) };
		}
		function parseEntryView(value) {
			const body = record(value, "entry");
			exactKeys(body, [
				"entryId",
				"sessionId",
				"title",
				"deletedAt",
				"sessionCount",
				"sizeBytes"
			], ["cwd"], "entry");
			for (const key of [
				"deletedAt",
				"sessionCount",
				"sizeBytes"
			]) {
				const field = body[key];
				if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new TypeError(`entry.${key} must be a non-negative integer`);
			}
			return {
				entryId: parseEntryId(body.entryId),
				sessionId: text(body.sessionId, "entry.sessionId", 512),
				title: text(body.title, "entry.title", 1e3),
				...body.cwd === void 0 ? {} : { cwd: text(body.cwd, "entry.cwd", 4096) },
				deletedAt: body.deletedAt,
				sessionCount: body.sessionCount,
				sizeBytes: body.sizeBytes
			};
		}
		function parsePendingRequest(value) {
			const body = record(value, "request");
			exactKeys(body, ["pendingId"], [], "request");
			return { pendingId: uuid(body.pendingId, "request.pendingId") };
		}
		function parsePendingView(value) {
			const body = record(value, "pending");
			exactKeys(body, [
				"pendingId",
				"sessionId",
				"title",
				"requestedAt"
			], ["cwd"], "pending");
			if (typeof body.requestedAt !== "number" || !Number.isSafeInteger(body.requestedAt) || body.requestedAt < 0) throw new TypeError("pending.requestedAt must be a non-negative integer");
			return {
				pendingId: uuid(body.pendingId, "pending.pendingId"),
				sessionId: text(body.sessionId, "pending.sessionId", 512),
				title: text(body.title, "pending.title", 1e3),
				...body.cwd === void 0 ? {} : { cwd: text(body.cwd, "pending.cwd", 4096) },
				requestedAt: body.requestedAt
			};
		}
		function parseIds(value, what) {
			if (!Array.isArray(value)) throw new TypeError(`${what} must be an array`);
			return value.map((id, index) => text(id, `${what}[${String(index)}]`, 512));
		}
		const T = `${SESSION_TRASH_PACKAGE}/types`;
		const requestCodecs = {
			move: strict(`${T}#MoveToTrashRequest`, parseMoveRequest),
			entry: strict(`${T}#TrashEntryRequest`, parseEntryRequest),
			pending: strict(`${T}#PendingMoveRequest`, parsePendingRequest)
		};
		const resultCodecs = {
			move: strict(`${T}#MoveToTrashResult`, (value) => {
				const body = record(value, "result");
				if ("pending" in body) {
					exactKeys(body, ["pending"], [], "result");
					return { pending: parsePendingView(body.pending) };
				}
				exactKeys(body, ["entry"], [], "result");
				return { entry: parseEntryView(body.entry) };
			}),
			list: strict(`${T}#TrashListResult`, (value) => {
				const body = record(value, "result");
				exactKeys(body, ["entries", "pending"], [], "result");
				if (!Array.isArray(body.entries)) throw new TypeError("result.entries must be an array");
				if (!Array.isArray(body.pending)) throw new TypeError("result.pending must be an array");
				return {
					entries: body.entries.map(parseEntryView),
					pending: body.pending.map(parsePendingView)
				};
			}),
			cancel: strict(`${T}#PendingMoveResult`, (value) => {
				const body = record(value, "result");
				exactKeys(body, ["sessionId"], [], "result");
				return { sessionId: text(body.sessionId, "result.sessionId", 512) };
			}),
			entry: strict(`${T}#TrashEntryResult`, (value) => {
				const body = record(value, "result");
				exactKeys(body, ["sessionIds"], [], "result");
				return { sessionIds: parseIds(body.sessionIds, "result.sessionIds") };
			})
		};
		function descriptor(method, parameters, result) {
			return {
				id: `${SESSION_TRASH_PACKAGE}#${SESSION_TRASH_NAMESPACE}/${method}`,
				service: SESSION_TRASH_NAMESPACE,
				namespace: SESSION_TRASH_NAMESPACE,
				method,
				invocation: { kind: "direct" },
				parameters: parameters.map((parameter) => ({
					name: parameter.name,
					wire: parameter.name,
					source: "json",
					codec: parameter.codec
				})),
				result,
				sourceLocation: {
					file: `${SESSION_TRASH_PACKAGE}/lib/index.js`,
					line: 1,
					column: 1
				}
			};
		}
		//#endregion
		//#region src/client/api.ts
		/** Contribution mounted on `ctx.remote`. */
		const SESSION_TRASH_REMOTE = {
			package: SESSION_TRASH_PACKAGE,
			descriptors: [
				descriptor("moveToTrash", [{
					name: "request",
					codec: requestCodecs.move
				}], resultCodecs.move),
				descriptor("listTrash", [], resultCodecs.list),
				descriptor("restore", [{
					name: "request",
					codec: requestCodecs.entry
				}], resultCodecs.entry),
				descriptor("purge", [{
					name: "request",
					codec: requestCodecs.entry
				}], resultCodecs.entry),
				descriptor("cancelPending", [{
					name: "request",
					codec: requestCodecs.pending
				}], resultCodecs.cancel)
			]
		};
		/** Namespace service key under which the Client Remote publishes the methods. */
		const REMOTE_SERVICE = `remote.${SESSION_TRASH_NAMESPACE}`;
		/** A failed call, already localized. */
		var TrashActionError = class extends Error {
			code;
			/**
			* @param message - localized text for the user.
			* @param code - Remote failure code, when the Host answered with one.
			*/
			constructor(message, code) {
				super(message);
				this.code = code;
				this.name = "TrashActionError";
			}
		};
		/**
		* Unwrap a Remote result, mapping each failure code to localized copy.
		* @param result - the Remote result.
		* @param t - translate function.
		* @returns the value of a successful call.
		*/
		function unwrap(result, t) {
			if (result.ok) return result.value;
			const { error } = result;
			const details = error.details;
			const field = (name) => {
				const value = typeof details === "object" && details !== null ? Reflect.get(details, name) : void 0;
				return typeof value === "string" ? value : "";
			};
			const code = error.code;
			switch (code) {
				case "session-trash/unsupported": throw new TrashActionError(t("error.unsupported", { reason: field("reason") }), code);
				case "session-trash/not-found": throw new TrashActionError(t("error.notFound"), code);
				case "session-trash/session-active": throw new TrashActionError(t("error.active"), code);
				case "session-trash/session-in-use": throw new TrashActionError(t("error.inUse"), code);
				case "session-trash/refused": throw new TrashActionError(t("error.refused", { reason: field("reason") }), code);
				case "session-trash/restore-conflict": throw new TrashActionError(t("error.conflict"), code);
				default: throw new TrashActionError(t("error.failed", { message: `${code}: ${error.message}` }), code);
			}
		}
		/**
		* Format a byte count for the trash list.
		* @param bytes - byte count.
		* @returns a short human-readable size.
		*/
		function formatBytes(bytes) {
			if (bytes < 1024) return `${String(bytes)} B`;
			const units = [
				"KB",
				"MB",
				"GB"
			];
			let value = bytes / 1024;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
		}
		//#endregion
		//#region src/client/components.tsx
		/**
		* The plugin's React surfaces: the "Move to trash" row of a Session's sidebar
		* menu, the confirmation it raises in `shell.overlay`, and the Session trash
		* settings page. Every destructive step asks first; a failed call leaves the
		* dialog open with the reason and changes nothing on screen.
		*/
		/**
		* Create a minimal subscribable value.
		* @param initial - starting value.
		* @returns the store.
		*/
		function createStore(initial) {
			let value = initial;
			const listeners = /* @__PURE__ */ new Set();
			return {
				get: () => value,
				set: (next) => {
					value = next;
					for (const listener of listeners) listener();
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				}
			};
		}
		function useStore(store) {
			const [value, setValue] = (0, react.useState)(store.get());
			(0, react.useEffect)(() => store.subscribe(() => {
				setValue(store.get());
			}), [store]);
			return value;
		}
		const styles = {
			section: {
				display: "flex",
				flexDirection: "column",
				gap: 16,
				padding: "4px 0"
			},
			header: {
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "space-between",
				gap: 12
			},
			title: {
				margin: 0,
				fontSize: 16,
				fontWeight: 600
			},
			subtitle: {
				margin: 0,
				fontSize: 14,
				fontWeight: 600
			},
			muted: {
				margin: "4px 0 0",
				fontSize: 13,
				opacity: .7,
				lineHeight: 1.5
			},
			actions: {
				display: "flex",
				gap: 8,
				flexShrink: 0
			},
			list: {
				listStyle: "none",
				margin: 0,
				padding: 0,
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			row: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 12,
				padding: "10px 12px",
				borderRadius: 10,
				border: "1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.25))"
			},
			rowText: {
				minWidth: 0,
				display: "flex",
				flexDirection: "column",
				gap: 2
			},
			rowTitle: {
				fontWeight: 500,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			meta: {
				fontSize: 12,
				opacity: .65,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			error: {
				fontSize: 13,
				color: "var(--dsw-alias-text-error, #d4380d)",
				lineHeight: 1.5
			},
			status: {
				fontSize: 13,
				opacity: .75
			}
		};
		/**
		* Menu row: close the menu, then ask for the move confirmation.
		* @param props - row identity, the menu state hook, and the request callback.
		* @returns the row.
		*/
		function MoveToTrashMenuItem({ sessionId, displayTitle, useMenuOpenState, requestMove, untitled, t }) {
			const [, setMenuOpen] = useMenuOpenState();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MenuItemButton, {
				danger: true,
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false);
					requestMove({
						sessionId,
						title: displayTitle === "" ? untitled : displayTitle
					});
				},
				children: t("menu.moveToTrash")
			});
		}
		/**
		* Overlay entry: nothing until a move is requested, then one dialog per request.
		* @param props - the request store, the move hop, and the translate function.
		* @returns the dialog, or null.
		*/
		function MoveToTrashDialog({ requests, moveToTrash, t }) {
			const request = useStore(requests);
			if (request === null) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MoveForm, {
				request,
				moveToTrash,
				onSettle: () => {
					requests.set(null);
				},
				t
			}, request.sessionId);
		}
		function MoveForm({ request, moveToTrash, onSettle, t }) {
			const [pending, setPending] = (0, react.useState)(false);
			const [deferred, setDeferred] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const close = () => {
				if (!pending) onSettle();
			};
			const confirm = () => {
				setPending(true);
				setError(null);
				moveToTrash(request).then((outcome) => {
					setPending(false);
					if (outcome === "pending") setDeferred(true);
					else onSettle();
				}, (reason) => {
					setPending(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			if (deferred) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: onSettle,
				closeLabel: t("close"),
				title: t("move.deferredTitle"),
				description: t("move.deferredDesc", { title: request.title }),
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					onClick: onSettle,
					children: t("move.deferredOk")
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("close"),
				title: t("move.title"),
				description: t("move.desc", { title: request.title }),
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					disabled: pending,
					onClick: close,
					children: t("cancel")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					disabled: pending,
					onClick: confirm,
					children: t("move.action")
				})] }),
				children: [pending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "status",
					style: styles.status,
					children: t("move.pending")
				}), error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "alert",
					style: styles.error,
					children: error
				})]
			});
		}
		/**
		* The Session trash settings page: the list, restore, and the two confirmed
		* permanent deletions.
		* @param props - the Remote hops and the translate function.
		* @returns the page.
		*/
		function TrashSection({ listTrash, restore, purge, cancelPending, t }) {
			const [entries, setEntries] = (0, react.useState)(null);
			const [pendingMoves, setPendingMoves] = (0, react.useState)([]);
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(null);
			const [confirmation, setConfirmation] = (0, react.useState)(null);
			const reload = (0, react.useCallback)(async () => {
				setError(null);
				try {
					const contents = await listTrash();
					setEntries(contents.entries);
					setPendingMoves(contents.pending);
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				}
			}, [listTrash]);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			const restoreEntry = (entry) => {
				setBusy(entry.entryId);
				setError(null);
				restore(entry.entryId).then(reload, (reason) => {
					setError(reason instanceof Error ? reason.message : String(reason));
				}).finally(() => {
					setBusy(null);
				});
			};
			const cancelMove = (move) => {
				setBusy(move.pendingId);
				setError(null);
				cancelPending(move.pendingId).then(reload, (reason) => {
					setError(reason instanceof Error ? reason.message : String(reason));
				}).finally(() => {
					setBusy(null);
				});
			};
			const dateFormat = new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: styles.section,
				"aria-label": t("section.title"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.header,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							style: styles.title,
							children: t("section.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles.muted,
							children: t("section.desc")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.actions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								disabled: busy !== null,
								onClick: () => {
									reload();
								},
								children: t("section.refresh")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								disabled: busy !== null || entries === null || entries.length === 0,
								onClick: () => {
									if (entries !== null) setConfirmation({
										kind: "empty",
										entries
									});
								},
								children: t("section.emptyTrash")
							})]
						})]
					}),
					error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						role: "alert",
						style: styles.error,
						children: error
					}),
					entries === null && error === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						role: "status",
						style: styles.status,
						children: t("section.loading")
					}),
					pendingMoves.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.section,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: styles.subtitle,
							children: t("section.pendingTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							style: styles.list,
							"aria-label": t("section.pendingTitle"),
							children: pendingMoves.map((move) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								style: styles.row,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles.rowText,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles.rowTitle,
											title: move.title,
											children: move.title
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles.meta,
											children: t("pending.requestedAt", { time: dateFormat.format(new Date(move.requestedAt)) })
										}),
										move.cwd !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles.meta,
											title: move.cwd,
											children: t("entry.cwd", { cwd: move.cwd })
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: styles.actions,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										size: "sm",
										variant: "outline",
										disabled: busy !== null,
										onClick: () => {
											cancelMove(move);
										},
										children: t("pending.cancel")
									})
								})]
							}, move.pendingId))
						})]
					}),
					entries !== null && entries.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: styles.muted,
						children: t("section.empty")
					}),
					entries !== null && entries.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						style: styles.list,
						children: entries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							style: styles.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.rowText,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: styles.rowTitle,
										title: entry.title,
										children: entry.title
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: styles.meta,
										children: t("entry.deletedAt", { time: dateFormat.format(new Date(entry.deletedAt)) })
									}),
									entry.cwd !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: styles.meta,
										title: entry.cwd,
										children: t("entry.cwd", { cwd: entry.cwd })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: styles.meta,
										children: t("entry.size", {
											sessions: entry.sessionCount,
											size: formatBytes(entry.sizeBytes)
										})
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.actions,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "outline",
									disabled: busy !== null,
									onClick: () => {
										restoreEntry(entry);
									},
									children: t("entry.restore")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "outline",
									disabled: busy !== null,
									onClick: () => {
										setConfirmation({
											kind: "purge",
											entry
										});
									},
									children: t("entry.purge")
								})]
							})]
						}, entry.entryId))
					}),
					confirmation !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PurgeDialog, {
						confirmation,
						purge,
						t,
						onSettle: (changed) => {
							setConfirmation(null);
							if (changed) reload();
						}
					})
				]
			});
		}
		function PurgeDialog({ confirmation, purge, onSettle, t }) {
			const [progress, setProgress] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [changed, setChanged] = (0, react.useState)(false);
			const targets = confirmation.kind === "purge" ? [confirmation.entry] : confirmation.entries;
			const pending = progress !== null;
			const close = () => {
				if (!pending) onSettle(changed);
			};
			const confirm = async () => {
				setError(null);
				for (let index = 0; index < targets.length; index += 1) {
					setProgress(index);
					try {
						await purge(targets[index].entryId);
						setChanged(true);
					} catch (reason) {
						setProgress(null);
						setChanged(true);
						setError(reason instanceof Error ? reason.message : String(reason));
						return;
					}
				}
				setProgress(null);
				onSettle(true);
			};
			const single = confirmation.kind === "purge";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("close"),
				title: single ? t("purge.title") : t("emptyTrash.title"),
				description: single ? t("purge.desc", {
					title: confirmation.entry.title,
					sessions: confirmation.entry.sessionCount
				}) : t("emptyTrash.desc", { count: targets.length }),
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					disabled: pending,
					onClick: close,
					children: t("cancel")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					disabled: pending,
					onClick: () => {
						confirm();
					},
					children: single ? t("purge.action") : t("emptyTrash.action")
				})] }),
				children: [pending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "status",
					style: styles.status,
					children: single ? t("purge.pending") : t("emptyTrash.pending", {
						done: progress,
						count: targets.length
					})
				}), error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "alert",
					style: styles.error,
					children: error
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Client copy for the `sessionTrash` locale namespace. */
		const zh = {
			"menu.moveToTrash": "移到回收站",
			"move.title": "将此会话移到回收站？",
			"move.desc": "“{title}”及其子智能体会话会从侧栏移除，并移入回收站。之后可在“设置 → 会话回收站”中恢复，或再次确认后永久删除。",
			"move.action": "移到回收站",
			"move.pending": "正在移到回收站…",
			"move.done": "已移到回收站",
			"move.deferredTitle": "已从侧栏隐藏",
			"move.deferredDesc": "“{title}”在本次启动中打开过，DSH 仍在使用它，所以现在不能移动它的文件。它已从侧栏隐藏，下次启动 DSH 时会自动移入回收站。在那之前，可以在“设置 → 会话回收站”中撤销。",
			"move.deferredOk": "知道了",
			"section.nav": "会话回收站",
			"section.title": "会话回收站",
			"section.desc": "移到回收站的会话会保留在这里，直到你恢复或永久删除它们。回收站不会自动清理。",
			"section.empty": "回收站是空的",
			"section.loading": "正在读取回收站…",
			"section.refresh": "刷新",
			"section.emptyTrash": "清空回收站",
			"section.pendingTitle": "等待移入（下次启动 DSH 时生效）",
			"pending.requestedAt": "请求时间：{time}",
			"pending.cancel": "撤销",
			"entry.deletedAt": "移入时间：{time}",
			"entry.cwd": "项目：{cwd}",
			"entry.size": "{sessions} 个会话记录，{size}",
			"entry.restore": "恢复",
			"entry.purge": "永久删除",
			"purge.title": "永久删除此会话？",
			"purge.desc": "将永久删除“{title}”的本地会话记录（含 {sessions} 个会话记录）。此操作无法撤销，项目文件不受影响。",
			"purge.action": "永久删除",
			"purge.pending": "正在永久删除…",
			"emptyTrash.title": "清空回收站？",
			"emptyTrash.desc": "将永久删除回收站中的全部 {count} 个会话。此操作无法撤销，项目文件不受影响。",
			"emptyTrash.action": "全部永久删除",
			"emptyTrash.pending": "正在清空（{done}/{count}）…",
			"error.unsupported": "当前环境不支持会话回收站：{reason}",
			"error.notFound": "找不到该会话或回收站条目，可能已被处理。",
			"error.active": "会话仍有正在进行的工作，请先停止或等待完成后再移到回收站。",
			"error.inUse": "另一个 DSH 进程（例如命令行）正在写入此会话。请先关闭它，再移到回收站。",
			"error.refused": "为安全起见已停止操作，未做任何改动：{reason}",
			"error.conflict": "原位置已存在同名会话，无法恢复。",
			"error.failed": "操作失败，未做任何改动：{message}"
		};
		const en = {
			"menu.moveToTrash": "Move to trash",
			"move.title": "Move this session to the trash?",
			"move.desc": "“{title}” and its subagent sessions leave the sidebar and go to the trash. You can restore them from Settings → Session trash, or delete them permanently after a second confirmation.",
			"move.action": "Move to trash",
			"move.pending": "Moving to trash…",
			"move.done": "Moved to trash",
			"move.deferredTitle": "Hidden from the sidebar",
			"move.deferredDesc": "“{title}” was opened in this run and DSH still uses it, so its files cannot move now. It is hidden from the sidebar and moves to the trash the next time DSH starts. Until then you can cancel this in Settings → Session trash.",
			"move.deferredOk": "OK",
			"section.nav": "Session trash",
			"section.title": "Session trash",
			"section.desc": "Sessions you move to the trash stay here until you restore them or delete them permanently. The trash is never emptied automatically.",
			"section.empty": "The trash is empty",
			"section.loading": "Reading the trash…",
			"section.refresh": "Refresh",
			"section.emptyTrash": "Empty trash",
			"section.pendingTitle": "Waiting to move (on the next DSH start)",
			"pending.requestedAt": "Requested: {time}",
			"pending.cancel": "Cancel",
			"entry.deletedAt": "Moved: {time}",
			"entry.cwd": "Project: {cwd}",
			"entry.size": "{sessions} session log(s), {size}",
			"entry.restore": "Restore",
			"entry.purge": "Delete permanently",
			"purge.title": "Delete this session permanently?",
			"purge.desc": "This permanently deletes the local session logs of “{title}” ({sessions} session log(s)). This cannot be undone. Project files are not affected.",
			"purge.action": "Delete permanently",
			"purge.pending": "Deleting…",
			"emptyTrash.title": "Empty the trash?",
			"emptyTrash.desc": "This permanently deletes all {count} sessions in the trash. This cannot be undone. Project files are not affected.",
			"emptyTrash.action": "Delete all permanently",
			"emptyTrash.pending": "Emptying ({done}/{count})…",
			"error.unsupported": "The session trash is not available here: {reason}",
			"error.notFound": "That session or trash entry no longer exists.",
			"error.active": "The session still has work in progress. Stop it or wait for it to finish, then move it to the trash.",
			"error.inUse": "Another DSH process (for example the command line) is writing this session. Close it, then move the session to the trash.",
			"error.refused": "Stopped for safety; nothing was changed: {reason}",
			"error.conflict": "A session already exists at the original location, so it cannot be restored.",
			"error.failed": "The operation failed and nothing was changed: {message}"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Locale namespace of this plugin's copy. */
		const NS = "sessionTrash";
		/** Client plugin name. */
		const name = "dsh-plugin-session-trash/client";
		/** Client services this plugin needs. */
		const inject = [
			"slots",
			"locale",
			"remote"
		];
		/**
		* Install the Remote contribution and the three slot entries.
		* @param ctx - Client root Context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "session-trash: dictionaries");
			const t = ctx.locale.bind(NS);
			const mounted = ctx.remote.$mount(SESSION_TRASH_REMOTE);
			ctx.effect(() => () => {
				mounted.then((dispose) => dispose());
			}, "session-trash: Remote methods");
			const remote = async () => {
				await mounted;
				return ctx.get(REMOTE_SERVICE);
			};
			const refreshSessions = async () => {
				await ctx.get("sessions")?.refresh();
			};
			const moveRequests = createStore(null);
			const moveToTrash = async (request) => {
				const title = request.title.length > 1e3 ? `${request.title.slice(0, 999)}…` : request.title;
				const result = unwrap(await (await remote()).moveToTrash({
					sessionId: request.sessionId,
					title
				}), t);
				await refreshSessions();
				return "pending" in result ? "pending" : "moved";
			};
			const listTrash = async () => unwrap(await (await remote()).listTrash(), t);
			const cancelPending = async (pendingId) => {
				unwrap(await (await remote()).cancelPending({ pendingId }), t);
				await refreshSessions();
			};
			const restore = async (entryId) => {
				unwrap(await (await remote()).restore({ entryId }), t);
				await refreshSessions();
			};
			const purge = async (entryId) => {
				unwrap(await (await remote()).purge({ entryId }), t);
			};
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "session-trash.move",
				order: 470,
				locale: NS
			}, (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MoveToTrashMenuItem, {
				sessionId: props.sessionId,
				displayTitle: props.displayTitle,
				useMenuOpenState: props.useMenuOpenState,
				requestMove: (request) => {
					moveRequests.set(request);
				},
				untitled: props.sessionId,
				t
			})));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "session-trash.move-confirm",
				locale: NS
			}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MoveToTrashDialog, {
				requests: moveRequests,
				moveToTrash,
				t
			})));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "session-trash",
				order: 70,
				label: () => t("section.nav"),
				locale: NS
			}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TrashSection, {
				listTrash,
				restore,
				purge,
				cancelPending,
				t
			})));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

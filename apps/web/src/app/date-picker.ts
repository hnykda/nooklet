/**
 * The app's one date picker host (B-96), shared by the commands (`CommandLayer.tsx` hands it to
 * `createCoreCommands`, so `/scheduled`, `/deadline` and the palette rows reach it) and by the
 * date chips on each row (`../editor/DateChips.tsx`). One instance, so a chip click and a slash
 * command can never disagree about how a pick is written.
 *
 * `createStore()` is stateless — a set of functions over the replica — so building one here
 * rather than borrowing `CommandLayer`'s changes nothing about where writes go.
 */
import { createDatePickerHost } from "../commands/date-picker/host.js";
import { createStore } from "./hosts.js";

export const blockDatePicker = createDatePickerHost({ store: createStore() });

// utils/dayjsSetup.ts
import dayjs from "dayjs";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore.js";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter.js"; // you'll likely want this too

dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

export default dayjs;
/**
 * B-644: names for new local graphs. Every one used to be called "This device", so a phone with
 * three of them showed three identical rows. A friendly two-word name tells them apart at a glance
 * and is still easy to rename (the switcher's pencil).
 *
 * The list is hand-picked: short, plain ASCII (they become slugs on the desktop, `main.rs#
 * slug_for_label`), no trademarks, nothing that reads oddly as the title of someone's notes.
 */
export const GRAPH_NAMES: readonly string[] = [
  "Quiet Otter",
  "Paper Lantern",
  "Amber Fern",
  "Velvet Moth",
  "Copper Kettle",
  "Hidden Meadow",
  "Silver Birch",
  "Morning Tide",
  "Wandering Fox",
  "Little Harbor",
  "Golden Hour",
  "Patient Heron",
  "Mossy Stone",
  "Tidy Burrow",
  "Bright Pebble",
  "Gentle Rain",
  "Hollow Oak",
  "Linen Sail",
  "Maple Lane",
  "Honey Badger",
  "Clever Crow",
  "Sleepy Owl",
  "Cedar Cabin",
  "Lemon Grove",
  "Woolly Sheep",
  "Pine Needle",
  "Rusty Gate",
  "Salt Marsh",
  "Bramble Patch",
  "Ink Well",
  "Sunny Porch",
  "Snow Hare",
  "Brave Sparrow",
  "Kind Badger",
  "Starlit Pond",
  "Willow Bend",
  "Clover Field",
  "Driftwood Shore",
  "Plum Orchard",
  "Thistle Down",
  "Garden Snail",
  "Lucky Penny",
  "Velvet Night",
  "Riverstone",
  "Hazel Nut",
  "Cosy Nook",
  "Teal Wave",
  "Busy Beaver",
  "Juniper Hill",
  "Sea Glass",
  "Wild Thyme",
  "Paper Crane",
  "Saffron Sky",
  "North Star",
  "Orchard Gate",
  "Lazy River",
  "Pocket Watch",
  "Fern Hollow",
  "Calm Lagoon",
  "Red Kite",
  "Blue Heron",
  "Ember Glow",
  "Misty Ridge",
  "Hearth Stone",
  "Puffin Rock",
  "Cinnamon Roll",
  "Dandelion Clock",
  "Hedgehog Trail",
  "Swift Brook",
  "Owl Feather",
  "Pebble Beach",
  "Chestnut Tree",
  "Robin Song",
  "Lavender Field",
  "Tin Lantern",
  "Wren Nest",
  "Kettle Pond",
  "Spruce Grove",
  "Indigo Bay",
  "Marble Arch",
  "Tumbleweed",
  "Barley Field",
  "Firefly Glen",
  "Acorn Cup",
  "Raindrop",
  "Moonlit Path",
  "Sandy Cove",
  "Quill Pen",
  "Harvest Moon",
  "Lichen Wall",
  "Seal Pup",
  "Nimble Squirrel",
  "Walnut Desk",
  "Starling Flock",
  "Cobble Street",
  "Meadow Lark",
  "Glass Marble",
  "Hilltop Mill",
  "Pine Marten",
  "Oak Leaf",
];

/** Case- and space-insensitive, so "quiet  otter" counts as taking "Quiet Otter". */
function normalize(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A name no entry in `taken` already uses. Picks at random among the curated names nobody has
 * yet; once every one is used, the picked name gets " 2", " 3", … — the first number not taken.
 * `random` is a seam for tests.
 */
export function generateGraphName(
  taken: Iterable<string>,
  random: () => number = Math.random,
): string {
  const used = new Set([...taken].map(normalize));
  const free = GRAPH_NAMES.filter((name) => !used.has(normalize(name)));
  if (free.length > 0) return free[Math.floor(random() * free.length) % free.length] as string;
  const base = GRAPH_NAMES[
    Math.floor(random() * GRAPH_NAMES.length) % GRAPH_NAMES.length
  ] as string;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(normalize(candidate))) return candidate;
  }
}

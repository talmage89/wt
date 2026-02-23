/**
 * Curated word list for generating memorable slot names.
 * Criteria: 3-7 characters, common English words, easy to read/type,
 * no offensive content. Mix of adjectives and nouns from nature, weather,
 * colors, animals, materials, textures, shapes, and time categories.
 */
export const WORDS: readonly string[] = [
  // Colors / minerals
  "amber", "azure", "coral", "ivory", "jade", "onyx", "opal", "pearl",
  "plum", "ruby", "slate", "steel", "teal", "violet",

  // Nature / plants
  "aspen", "birch", "bloom", "cedar", "fern", "forest", "glade", "grove",
  "hazel", "holly", "leaf", "maple", "moss", "oak", "pine", "sage",
  "spruce", "thorn", "vine", "willow",

  // Weather / sky
  "blaze", "bolt", "breeze", "chill", "cloud", "dawn", "drift", "dusk",
  "ember", "flame", "flint", "frost", "mist", "rain", "snow", "spark",
  "storm", "tide", "wind",

  // Water / terrain
  "brook", "cliff", "creek", "delta", "marsh", "meadow", "peak", "pond",
  "ridge", "river", "shore", "trail", "vale",

  // Animals / birds
  "crane", "eagle", "hawk", "heron", "lark", "otter", "raven", "robin",
  "swift", "tiger", "wren",

  // Materials / textures
  "crystal", "linen", "prism", "quartz", "velvet",

  // Space / time / direction
  "lunar", "north", "orbit", "south", "zenith",

  // Other good ones
  "atlas", "autumn", "bright", "calm", "crisp", "crown", "gleam", "haven",
  "light", "noble", "silver", "stone",

  // More nature
  "acorn", "algae", "alder", "aloe", "arch", "ash", "bale", "bark",
  "basin", "bay", "beam", "bench", "berry", "blade", "bough", "bract",
  "briar", "brine", "brush", "bud", "bulb", "burrow", "cairn", "canyon",
  "cape", "cinder", "crest", "dew", "dome", "dune", "eddy", "fen",
  "field", "fjord", "floe", "flume", "foam", "ford", "frond", "gale",
  "garnet", "geyser", "gill", "glass", "glaze", "glen", "glow",
  "grain", "gravel", "grotto", "gust", "heath", "hedge", "hill", "hoar",
  "hull", "husk", "inlet", "iris", "isle", "ivy", "kelp", "knoll",
  "lagoon", "lake", "larch", "lava", "ledge", "lime", "loam", "loch",
  "loft", "log", "luna", "lune", "lupine", "marl", "mesa", "moat",
  "moor", "mote", "nave", "nest", "nettle", "nook", "notch", "nub",
  "olive", "palm", "peat", "pebble", "petal", "pitch", "plain", "polar",
  "pool", "poplar", "pore", "quill", "rapids", "reed", "reef", "rind",
  "rock", "root", "rose", "rush", "sand", "sedge", "seep", "shale",
  "shoal", "silt", "slab", "sleet", "slope", "sol", "span", "spar",
  "spit", "spray", "spur", "stem", "straw", "surf", "surge", "swamp",
  "talon", "terra", "thaw", "timber", "torrent",
  "trunk", "tuft", "tundra", "vapor", "vault", "vent", "verge",
  "virid", "vista", "wane", "wax", "well", "wetland", "whirl", "wisp",
  "wood", "wynd",

  // More animals
  "adder", "bison", "bream", "brent", "bur", "carp", "clam",
  "colt", "coot", "crab", "crow", "cub", "dace", "deer", "dove", "duck",
  "egret", "elk", "erne", "finch", "flock", "foal", "fox", "frog",
  "grouse", "gull", "hare", "hart", "hind", "ibis", "kite", "krill",
  "lamb", "lapwing", "linnet", "loon", "lynx", "marten", "merlin",
  "mink", "mole", "moose", "moth", "mule", "newt", "nutmeg", "nymph",
  "oriole", "osprey", "oxbow", "perch", "pipit", "plover", "puffin",
  "quail", "ram", "raptor", "roach", "roebuck", "rook", "rudd", "ruff",
  "sable", "snipe", "sparrow", "stag", "stoat", "stork", "swallow",
  "swan", "tern", "thrush", "trout", "vole", "warbler", "weasel",
  "widgeon", "willet", "wolf", "wombat",

  // Adjectives
  "agile", "airy", "alert", "aloft", "apt", "arched", "ardent", "arid",
  "artful", "ashy", "baked", "balmy", "bare", "barren", "bent", "bland",
  "bleak", "bold", "brisk", "broad", "buoyant", "clear", "close",
  "cobalt", "cold", "cool", "curved", "dark", "deep", "dense",
  "dim", "dire", "dry", "dull", "dun", "dusky", "dusty", "early",
  "even", "faint", "fair", "far", "fast", "fine", "firm", "flat",
  "fluid", "free", "fresh", "full", "golden", "grand", "gray", "great",
  "green", "grey", "grim", "gross", "hale", "hard", "heavy", "high",
  "hollow", "humid", "hushed", "icy", "inert", "keen", "kind", "large",
  "late", "lean", "level", "lithe", "livid", "lofty", "lone", "long",
  "loud", "low", "lucid", "lumpy", "mild", "muted", "narrow", "neat",
  "nimble", "oblique", "open", "oval", "pale", "porous",
  "prime", "pure", "quiet", "rapid", "raw", "rigid", "rough", "round",
  "ruddy", "rustic", "sandy", "serene", "sharp", "sheer", "short",
  "shrill", "silent", "slim", "slow", "small", "smooth", "soft",
  "solemn", "sparse", "steep", "stiff", "still", "stout", "subtle",
  "sunny", "taut", "thick", "thin", "true", "vast", "vivid", "warm",
  "wide", "wild", "worn", "young",
] as const;

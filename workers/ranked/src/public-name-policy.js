// Append-only vocabulary keeps existing word indices and legacy aliases stable.
const PROFILE_NAME_WORD_A = Object.freeze([
  "swift", "neon", "alpha", "turbo", "sonic", "pixel", "nova", "lucky",
  "sunny", "frost", "ember", "quantum", "crystal", "midnight", "solar", "lunar",
  "hyper", "ultra", "aero", "rapid", "vivid", "thunder", "cosmic", "silver",
  "golden", "shadow", "arc", "vector", "iron", "onyx", "starlit", "cobalt",
  "ripple", "granite", "jungle", "desert", "arctic", "magenta", "scarlet", "violet",
  "teal", "sable", "amber", "jade", "ivory", "obsidian", "cinder", "stellar",
  "orbital", "zen", "rogue", "prime", "apex", "summit", "embered", "misty",
  "horizon", "aurora", "glitch", "byte", "laser", "prism", "halo", "north",
  "south", "east", "west", "tempo", "axle", "torque", "nitro", "clutch",
  "summoner", "phantom", "eclipse", "cyclone", "monsoon", "titan", "pegasus", "raven",
  "falcon", "lynx", "otter", "comfy", "bouncy", "cheery", "zippy", "daring",
  "brisk", "fuzzy", "mellow", "witty", "snappy", "goofy", "wobbly", "noodle",
  "waffle", "jelly", "marshmallow", "bubble", "pickled", "crispy", "crunchy", "squishy",
  "squeaky", "sleepy", "dizzy", "giggly", "jolly", "jazzy", "groovy", "funky",
  "disco", "dapper", "fluffy", "feisty", "fizzy", "breezy", "toasty", "chilly",
  "frosty", "spicy", "tangy", "minty", "peachy", "plucky", "perky", "peppy",
  "spry", "sneaky", "silly", "quirky", "wonky", "wiggly", "wobble", "taffy",
  "mochi", "mango", "banana", "coconut", "pineapple", "popcorn", "biscuit", "donut",
  "cupcake", "pretzel", "pancake", "pudding", "confetti", "rainbow", "sprinkles", "stardust",
  "moonlit", "sunlit", "twinkly", "sparkly", "electric", "velvety", "whimsical", "rubbery",
  "astral", "stormy", "buttery", "feline", "harmonic", "speedy", "gentle", "celestial",
  "rainy", "caramel", "canine", "harmonious", "speeding", "friendly", "galactic", "drizzly",
  "caramelized", "vulpine", "rhythmic", "speedster", "grinning", "nebular", "gusty", "cinnamon",
  "lupine", "syncopated", "fleet", "smiling", "starry", "blustery", "cocoa", "feathered",
  "jazzing", "fleeting", "beaming", "starbound", "windy", "chocolate", "feathery", "bluesy",
  "agile", "buoyant", "starbright", "windswept", "chocolaty", "furry", "brassy", "nifty",
  "blithe", "starlight", "snowy", "vanilla", "floofy", "percussive", "nippy", "blissful",
  "moonswept", "snowbound", "blueberry", "woolly", "orchestral", "zipping", "gleeful", "moonbeam",
  "snowflake", "strawberry", "wooly", "symphonic", "zooming", "joyful", "moonstone", "snowfall",
  "raspberry", "purring", "acoustic", "zoomy", "joyous", "moonrock", "sleety", "blackberry",
  "chirpy", "electronic", "zoom", "jubilant", "sunbeam", "hazy", "cranberry", "chirping",
  "choral", "vroom", "jovial", "sunburst", "foggy", "cherry", "tweeting", "tuneful",
  "vrooming", "merry", "sunshine", "cloudy", "apricot", "hopping", "humming", "revving",
  "merrymaking", "sunshiny", "cloudbound", "nectarine", "leaping", "hummable", "revved", "playful",
  "sundrenched", "cloudlike", "tangerine", "bounding", "singing", "revvedup", "frolicsome", "dawnlit",
  "cloudless", "clementine", "bouncing", "songful", "geared", "frolicking", "daybreak", "thundery",
  "kiwi", "skipping", "musical", "gearing", "carefree", "dusk", "lightning", "lemon",
  "prancing", "lyrical", "shifting", "upbeat", "dusky", "balmy", "lime", "galloping",
  "lyric", "shifted", "bright", "twilight", "dewy", "citrus", "trotting", "bopping",
  "cruising", "brilliant", "cometary", "rainkissed", "citrusy", "cantering", "boogie", "coasting",
  "clever", "meteoric", "rainwashed", "zesty", "lolloping", "jamming", "coastal", "nimble",
  "meteorite", "rainstorm", "zestful", "scampering", "jiving", "cornering", "dauntless", "saturnine",
  "dewdrop", "sugary", "scurrying", "swinging", "banking", "fearless", "jovian", "dewkissed",
  "sugarplum", "scuttling", "swingy", "banked", "spirited", "mercurial", "boreal", "sugared",
  "fluttering", "swingtime", "overtaking", "sprightly", "neptunian", "polar", "honey", "flapping",
  "ragtime", "lapping", "lively", "plutonian", "glacial", "honeyed", "soaring", "grooving",
  "tailwind", "vivacious", "radiant", "glacier", "maple", "gliding", "rocking", "headwind",
  "vibrant", "luminous", "tropical", "molasses", "swooping", "twangy", "driftwood", "boisterous"
]);
const PROFILE_NAME_WORD_B = Object.freeze([
  "racer", "drift", "pulse", "track", "echo", "comet", "storm", "shift",
  "vault", "spark", "dash", "glide", "runner", "rocket", "flare", "nexus",
  "voyage", "blaze", "orbit", "flux", "drive", "streak", "zenith", "quartz",
  "radar", "pilot", "charger", "phantom", "matrix", "engine", "jumper", "hopper",
  "sprinter", "raider", "seeker", "keeper", "walker", "slider", "cruiser", "strider",
  "booster", "chaser", "panther", "falcon", "otter", "fox", "rhino", "yak",
  "wizard", "knight", "samurai", "sage", "ranger", "captain", "doctor", "baron",
  "duke", "rookie", "veteran", "legend", "maverick", "stomper", "breaker", "spirit",
  "beacon", "anchor", "vector", "module", "kernel", "vortex", "quasar", "galaxy",
  "planet", "meteor", "asteroid", "volcano", "tsunami", "whirl", "tempest", "charge",
  "vertex", "pixel", "bit", "byte", "gear", "piston", "engineer", "driver",
  "rider", "climber", "surfer", "skater", "sniper", "ace", "waffle", "noodle",
  "dumpling", "pancake", "muffin", "biscuit", "donut", "pretzel", "taco", "burrito",
  "pickle", "potato", "pumpkin", "coconut", "pineapple", "mango", "mochi", "marshmallow",
  "popcorn", "pudding", "jellybean", "cupcake", "bagel", "crumpet", "croissant", "raccoon",
  "capybara", "penguin", "puffin", "axolotl", "gecko", "koala", "panda", "wombat",
  "platypus", "duck", "goose", "flamingo", "pelican", "toucan", "alpaca", "llama",
  "narwhal", "dolphin", "walrus", "seal", "badger", "hedgehog", "hamster", "chinchilla",
  "squirrel", "ferret", "dragon", "griffin", "yeti", "goblin", "gremlin", "gnome",
  "jester", "astronaut", "explorer", "cartographer", "tinkerer", "tuba", "kazoo", "ukulele",
  "aurora", "cloud", "cookie", "cat", "banjo", "roadster", "joker", "nebula",
  "cloudbank", "brownie", "kitten", "guitar", "speedster", "harlequin", "satellite", "cloudburst",
  "blondie", "dog", "fiddle", "hotrod", "acrobat", "starlight", "raincloud", "scone",
  "puppy", "violin", "dragster", "tumbler", "moonbeam", "rainbow", "crisp", "beagle",
  "viola", "kart", "juggler", "moonstone", "raindrop", "crumble", "poodle", "cello",
  "gokart", "magician", "moonlet", "rainstorm", "cracker", "collie", "bassoon", "rallycar",
  "trickster", "moon", "rainfall", "crouton", "corgi", "oboe", "racecar", "prankster",
  "sun", "drizzle", "brioche", "dachshund", "clarinet", "stockcar", "dreamer", "sunrise",
  "downpour", "biscotti", "terrier", "flute", "supercar", "daydreamer", "sunset", "snowflake",
  "macaron", "husky", "piccolo", "hypercar", "trailblazer", "sunbeam", "snowball", "macaroon",
  "shiba", "recorder", "coupe", "pathfinder", "sunburst", "snowdrift", "eclair", "spaniel",
  "saxophone", "sedan", "wayfarer", "sunshine", "snowbank", "tart", "retriever", "sax",
  "wagon", "wanderer", "sundial", "snowfall", "tartlet", "wolf", "trumpet", "hatchback",
  "rambler", "star", "snowstorm", "pie", "wolfhound", "trombone", "buggy", "roamer",
  "starship", "snowman", "cobbler", "coyote", "cornet", "dunebuggy", "voyager", "starfleet",
  "icicle", "souffle", "dingo", "flugelhorn", "minivan", "adventurer", "stargazer", "iceberg",
  "pavlova", "jackal", "euphonium", "van", "navigator", "starburst", "glacier", "meringue",
  "hyena", "frenchhorn", "pickup", "pioneer", "stardust", "glade", "custard", "bobcat",
  "harmonica", "truck", "scout", "pulsar", "hailstone", "sundae", "lynx", "accordion",
  "monstertruck", "champion", "quark", "sleet", "gelato", "ocelot", "concertina", "tractor",
  "champ", "boson", "blizzard", "sorbet", "jaguar", "melodica", "trailer", "hero",
  "proton", "breeze", "sherbet", "leopard", "harmonium", "camper", "superhero", "neutron",
  "gust", "parfait", "cheetah", "piano", "motorhome", "sidekick", "neutrino", "wind",
  "yogurt", "lion", "keyboard", "scooter", "buddy", "photon", "windmill", "popsicle",
  "tiger", "synth", "moped", "pal", "electron", "windsock", "lollipop", "cougar",
  "organ", "motorbike", "friend", "ion", "tailwind", "bonbon", "puma", "keytar",
  "bicycle", "companion", "isotope", "headwind", "truffle", "caracal", "dulcimer", "tricycle",
  "chum", "atom", "whirlwind", "fudge", "serval", "harp", "unicycle", "teamster"
]);
const DEFAULT_NAME_BLOCKLIST = ["admin","moderator","owner","staff","support","system","dev","developer","verified","helper","official","security","abuse","abuser","anal","anus","arse","arsehole","ass","assbag","assclown","assface","assfuck","assfucker","asshat","asshole","assholes","asslicker","asswipe","ballsack","bastard","bastards","beaner","bestiality","bitch","bitches","bitchy","blowjob","blowjobs","bollock","bollocks","boner","boob","boobs","booty","brothel","bullshit","buttfuck","butthole","cameltoe","chink","clit","clitoris","cock","cocks","coon","crap","cum","cumming","cunt","cunts","dick","dicks","dildo","dildos","dipshit","doggystyle","douche","douchebag","dyke","fag","faggot","faggots","feck","fellatio","fingerbang","fuck","fucked","fucker","fuckers","fuckface","fucking","fuckoff","fuckwit","fuk","gangbang","gaylord","genitals","gook","handjob","hardcore","hentai","hitler","hoe","hoes","horny","incest","jailbait","jackass","jerkoff","jizz","kike","kkk","kunt","lesbo","loli","masturbate","masturbation","milf","motherfucker","motherfucking","muff","nazi","nazism","necrophilia","negro","nigga","niggah","nigger","niggers","niglet","nipple","nipples","nutjob","orgasm","orgy","pedo","pedophile","penis","piss","pissed","pisser","playboy","poon","poop","porn","porno","pornhub","prostitute","pussy","queef","raped","raper","rapist","rape","retard","rimjob","scrotum","sex","sexy","shit","shits","shitty","shota","sissy","skank","slut","sluts","smegma","spic","spunk","strapon","suck","sucks","testicle","threesome","tit","tits","titties","titty","tranny","twat","vag","vagina","vibrator","virgin","voyeur","wank","wanker","whore","whores","wtf","xxx","xrated","yaoi","zoophile","zoophilia","alqaeda","isis","terrorist","swastika","1488","molest","molester","underage","childporn","cp","suicide","killyourself","kys","racist","racism","whitepower","wetback","spick","gimp","cripple","idiot","moron","stupid","dumbass","shithead","cumdumpster","cumshot","cumslut","deepthroat","fisting","gangrape","gfy","goatse","groomer","hooker","hotsex","humping","jackoff","motherfucker","nutsack","pecker","peehole","peeing","pussylicking","rectum","scat","semen","sexcam","sexchat","sexworker","shemale","slapper","sodomize","sodomy","tard","teabagging","towelhead","tubgirl","unclefucker","upskirt","urethra","urine","vulva","wigger","willy","yid"];
const MODERN_HIGH_RISK_TERMS = ['merde','mierda','scheisse','kurwa','pendejo','cabron','joder','chingada','cocaine','heroin','fentanyl','gooning','gooner','goonette','edging','edgeplay','gyatt','gyat','onlyfans','ofans','discordmod','heilhitler','gasjews','gas all jews','sieg heil','killall','kms','killyourself','kys','unaliveyourself','csam','cporn','childlover','minorlover','lolicon','shotacon'];
const COMPACT_SEVERE_TERMS = ['nigger','niggre','nigre','nigga','niggah','niglet','faggot','chink','kike','spic','wetback','beaner','coon','gook','tranny','fuck','bitch','cunt','rape','rapist','pedophile','molester','childporn','csam','killyourself','whitepower','heilhitler','siegheil','gasalljews','bestiality','necrophilia','jailbait','cumdumpster','pornhub','onlyfans','gooning','masterbait','masterbaiting','masterofbaiting'];
const RESERVED_NAME_TERMS = ['admin','administrator','moderator','modteam','owner','staff','support','system','developer','devteam','verified','official','staticquasar931'];
const TARGETED_EXACT_NAMES = Object.freeze(['Kim Jong Un','Ngrachio445','Nigervaan','Stephen Hawking','Remlover','porp']
  .map(value => normalizeNameForCheck(value).replace(/ /g, '')));

export function sanitizeDisplayName(value) {
  const name = String(value || '').normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 24);
  return name || 'Guest';
}

export function normalizeNameForCheck(value) {
  const confusables = {
    'а':'a','в':'b','с':'c','е':'e','н':'h','і':'i','ј':'j','к':'k','м':'m','о':'o','р':'p','ѕ':'s','т':'t','у':'y','х':'x','ı':'i',
    'α':'a','β':'b','ε':'e','ι':'i','κ':'k','ο':'o','ρ':'p','τ':'t','υ':'u','χ':'x',
    // Small-cap and phonetic Latin letters commonly used as font-style swaps.
    'ß':'ss','ʃ':'f','ƒ':'f','ƈ':'c','ɦ':'h','ɢ':'g','ɡ':'g','ɪ':'i','ᴋ':'k','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','ʀ':'r','ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w',
    // Additional high-confidence cross-script lookalikes used in Latin text.
    'ԁ':'d','ԛ':'q','ժ':'h','ս':'u','ո':'n','օ':'o','ր':'r','ᴄ':'c','ᴅ':'d','ᴇ':'e','ғ':'f','ᴊ':'j','ʟ':'l'
  };
  // Enclosed emoji letters do not all have compatibility decompositions.
  const visibleLetters=Array.from(String(value||''),char=>{
    const code=char.codePointAt(0);
    for(const start of [0x1f130,0x1f150,0x1f170,0x1f1e6])if(code>=start&&code<start+26)return String.fromCharCode(97+code-start);
    return char;
  }).join('');
  // Preserve the c-shaped lunate sigma's visual meaning before NFKD turns it into ordinary sigma.
  return Array.from(visibleLetters.replace(/[ϲϹ]/g,'c').replace(/Υ/g,'Y').normalize('NFKD').toLowerCase().replace(/\p{M}/gu, ''), char => confusables[char] || char).join('')
    .replace(/[@4]/g, 'a').replace(/[8]/g, 'b').replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i').replace(/[0]/g, 'o').replace(/[5$]/g, 's')
    .replace(/[7+]/g, 't').replace(/[^a-z0-9Ѐ-ӿ぀-ヿ一-鿿]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const PREPARED_NAME_TERMS = Object.freeze(
  DEFAULT_NAME_BLOCKLIST.concat(MODERN_HIGH_RISK_TERMS)
    .map(normalizeNameForCheck)
    // CP alone is also a checkpoint abbreviation; explicit abuse compounds are checked separately.
    .filter(value=>Boolean(value)&&value!=='cp')
    .map(value => Object.freeze({ value, phrase: value.includes(' ') }))
);
const PREPARED_RESERVED_NAMES = Object.freeze(
  RESERVED_NAME_TERMS.map(value => normalizeNameForCheck(value).replace(/ /g, ''))
);
const PREPARED_SEVERE_NEEDLES = Object.freeze(
  COMPACT_SEVERE_TERMS.map(value => normalizeNameForCheck(value).replace(/ /g, '')).filter(value => value.length >= 4)
);
const UNAMBIGUOUS_EMBEDDED_TERMS = new Set(['nigger','nigga','niglet','niggah','faggot','childporn','csam','killyourself','whitepower','heilhitler','siegheil','gasalljews']);
const EXPLICIT_COMPOUNDS = Object.freeze([
  'epsteintouchesme',
  'touchmedaddy','touchmyclit','fingerme','jerkmeoff','jerkingoff','freenuds',
  'dirtytwink','goldenshower','2girls1cup','2girlsonecup','twogirlsonecup',
  'wreckmybed','periodbloodinmymouth','pissonmyface','shitonme',
  'womantoucher','womentoucher','imgoingtotouchyou','refard','rapsist',
  'breedme','spankme','sitonmyface','sendnakedpics','nakedchildren','nakedkids','teenporn',
  'shoulddie','mustdie','deservetodie','deservestodie','iwillkillyou','youmustdie',
  'killall','cpdealer','cpseller','tradecp'
]);
// Selected terms adapted from Shutterstock, Inc. (2012-2020), LDNOOBW English list:
// https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/blob/master/en
// CC BY 4.0: https://creativecommons.org/licenses/by/4.0/
// Only these three unambiguous terms are selected; matching and grammar are local adaptations.
const CURATED_EXPLICIT_TERMS = Object.freeze(['paedophile','anilingus','cunnilingus']);
const EMBEDDED_UNSAFE_WORDS = Object.freeze([
  'fuck','bitch','cunt','pussy','pussi','penis','cock','dick','porn','retard','rapist','rapsist','raper','clitoris',
  'molester','pedophile','onlyfans','childporn','csam','nigger','nigga','niggah','niglet','shit','dumbass',
  'nude','faggot','cumshot','cumdumpster','cumslut','blowjob','handjob','nudes',
  'diddy','epstein','hitler','biden','obama','putin','trump','nazi','swastika','hentai','jailbait','lolicon','shotacon','zoophile','zoophilia',
  'necrophilia','bestiality','dildo','masturbat','orgasm','gangbang','rimjob','fisting',
  'incest','jizz','scrotum','testicle','vagina','vulva','nipple','boobs','titties',
  'fuk','fuq','phuck','phuk','fvck','fck','b1tch','biatch','bytch','kunt','nixxer'
]);
// Protect innocent lexical matches, not entire names: another unsafe part still blocks.
const BENIGN_EMBEDDED_WORDS = Object.freeze({
  coon:['raccoon'], spic:['spicy'], csam:['samurai'], cunt:['scunthorpe'], rape:['grape','drape','scrape'], rapist:['therapist','piston'], raper:['rapper','draper','scraper'],
  dick:['dickinson','dickens','dickson','benedict','dickey','dickman','dickerson'],
  cock:['peacock','cockpit','cockatoo','cockburn','hancock','woodcock','shuttlecock','cockrell','cockermouth','cockerell','cockerspaniel','cockney'],
  penis:['peniston','peniscola'], pussi:['pussini','pussinboots'], shit:['shitake','shitzu','shittim'], fuk:['fukushima','fukuda','fukui','fukuoka','fukuyama','fukuzawa'],
  diddy:['diddykong'], killall:['skillall'], nazi:['nazim','nazir'], trump:['trumpet','trumpington']
});
const BENIGN_EXACT_NAMES = new Set(['cockadoodledoo']);
const PREPARED_EMBEDDED_RULES = Object.freeze([...new Set(EMBEDDED_UNSAFE_WORDS.concat(EXPLICIT_COMPOUNDS,CURATED_EXPLICIT_TERMS)
  .map(value=>normalizeNameForCheck(value).replace(/ /g,'')))].map(term=>Object.freeze({term,
    pattern:new RegExp(term.replace(/([a-z0-9])\1*/g,run=>run[0]+'{'+run.length+',}'))
  })));
// Boundaries preserve ordinary words; optional spaces and elongation cover spelling evasions.
function contextWords(words) {
  return '(?:'+words.map(word=>normalizeNameForCheck(word).replace(/ /g,'')
    .split('').map(letter=>letter+'+').join(' *')).join('|')+')';
}
function contextFiller(words, limit = 3) {
  return '(?:'+contextWords(words)+' *){0,'+limit+'}';
}
function contextRule(term, parts, endOnly = false) {
  return Object.freeze({term,pattern:new RegExp('(?:^| )(?:x+ *)?('+parts.join(' *')+')' +
    '(?: *x+)?(?='+(endOnly?'$':'$| ')+')')});
}
const CHILD_TARGET = contextWords(['children','child','kids','kid','minors','minor','babies','baby','teens','teen']);
const TOUCH_ACTION = contextWords(['touching','touches','touched','touch','groping','gropes','groped','grope',
  'fondling','fondles','fondled','fondle','molesting','molests','molested','molest','grooming','grooms','groomed','groom']);
const ABUSE_ROLE = contextWords(['touchers','toucher','gropers','groper','molesters','molester','groomers','groomer','lovers','lover']);
const CHILD_FILLER = contextFiller(['the','my','your','our','a','an','all','of','those','these','little','young','very','small']);
const ACTION_PREFIX = contextFiller(['i','im','iam','we','will','would','want','to','love','like','enjoy','just','please','let','me']);
const SEXUAL_CONTEXT = contextWords(['sex','sexual','sexually','porn','nudes','nude','naked','erotic']);
const VIOLENT_ACTION = contextWords(['kill','kills','killing','killed','murder','murders','murdering','murdered',
  'shoot','shoots','shooting','shot','hang','hangs','hanging','hanged','gas','gasses','gassing','gassed',
  'exterminate','exterminates','exterminating','exterminated']);
const VIOLENT_TARGET = contextWords(['men','man','women','woman','males','male','females','female',
  'boys','boy','girls','girl','kids','kid','children','child','minors','minor','teens','teen',
  'jews','jew','jewish people','muslims','muslim','christians','christian','hindus','hindu',
  'asians','asian','blacks','whites','black people','white people','gay people','gays','lesbians',
  'trans people','transgender people','nonbinary people','nonbinary','immigrants','people','everyone','you']);
const VIOLENT_FILLER = contextFiller(['all','of','the','those','these','every','last','very','some','young'],4);
const CONTEXTUAL_NAME_RULES = Object.freeze([
  contextRule('child-directed-touch',[ACTION_PREFIX,TOUCH_ACTION,CHILD_FILLER,CHILD_TARGET]),
  contextRule('child-abuse-role',[CHILD_TARGET,CHILD_FILLER,ABUSE_ROLE]),
  contextRule('child-abuse-role',[ABUSE_ROLE,CHILD_FILLER,CHILD_TARGET]),
  contextRule('child-directed-touch',[CHILD_TARGET,contextFiller(['who','is','are','was','were','keeps','keep']),
    TOUCH_ACTION,contextFiller(['by','with','the','my','your']),contextWords(['me','you','him','her','us','them','daddy','adults','adult'])]),
  contextRule('child-directed-touch',[CHILD_TARGET,contextWords(['is','are','was','were','gets','got','getting','being']),
    contextFiller(['being','really','just'],2),contextWords(['touched','groped','fondled','molested','groomed'])]),
  // A trailing action alone is an abuse handle; an object such as Controls or Finish stays distinct.
  contextRule('child-directed-touch',[CHILD_TARGET,contextFiller(['love','loves','like','likes','to','really']),TOUCH_ACTION],true),
  // Love by itself never supplies sexual context: KidLovesRacing and ILoveMyKids are ordinary names.
  contextRule('child-sexual-context',[ACTION_PREFIX,CHILD_TARGET,
    contextFiller(['who','is','are','wants','want','loves','love','likes','like','needs','need','having','have','has','with','for','and','really','to']),SEXUAL_CONTEXT]),
  contextRule('child-sexual-context',[SEXUAL_CONTEXT,contextFiller(['with','of','for','the','my','your','little','young']),CHILD_TARGET]),
  contextRule('targeted-violence',[ACTION_PREFIX,VIOLENT_ACTION,VIOLENT_FILLER,VIOLENT_TARGET]),
  contextRule('targeted-violence',[VIOLENT_TARGET,contextWords(['should','must','need to','needs to','have to','has to','deserve to','deserves to','will']),
    contextFiller(['all','really','just'],2),contextWords(['die','be dead','be killed','be murdered','be shot','be hanged','be gassed','be exterminated'])])
]);
function contextualNameMatch(comparison) {
  const base=String(comparison).normalize('NFKC');
  const spaced=base.replace(/([\p{Ll}\d])(\p{Lu})/gu,'$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu,'$1 $2');
  const forms=new Set([base,spaced,base.replace(/\d{1,6}$/,''),spaced.replace(/\d{1,6}$/,'')].map(normalizeNameForCheck));
  for(const normalized of forms)for(const rule of CONTEXTUAL_NAME_RULES){
    const match=rule.pattern.exec(normalized);
    if(match)return {term:rule.term,normalized:match[1]};
  }
  return null;
}

const CLEAR_SLUR_ALIASES = /^(?:[xi]*)(?:niga|nijjer|nigher|niigher|nighger|niggef|niggej|nigja|niqqer|nixxer)(?:[x0-9]*)$/;


// Deliberately curated: ambiguous ordinary words (e.g. trump, bush, may) are not substring bans.
const POLITICAL_IDENTIFIERS = Object.freeze([
  'donaldtrump','joebiden','kamalaharris','barackobama','vladimirputin',
  'benitomussolini','adolfhitler','kimjongun','xijinping','netanyahu','votetrump','votebiden',
  'voterepublican','votedemocrat','trump2024','trump2028','biden2024','harris2024',
  'makeamericagreatagain','heilhitler','siegheil','whitepower','gasjews'
]);
const POLITICAL_TOKENS = new Set(['maga','trump','biden','putin','obama','political','republican','democrat','fascist','nazism']);
const CONTACT_BRANDS = Object.freeze(['discord','instagram','insta','snapchat','telegram','onlyfans','tiktok','youtube','twitch','facebook','patreon']);
const CONTACT_PATTERNS = Object.freeze(CONTACT_BRANDS.map(term=>new RegExp(term.replace(/([a-z])\1*/g,run=>run[0]+'{'+run.length+',}'))));
const HOMOGLYPH_ADULT_SITE_ALIASES = Object.freeze(['poгnhub']);
function promotionMatch(clean, normalized, compact) {
  // Check structure before leetspeak changes dots, numbers, or @ in URLs and contact addresses.
  const raw=String(clean).normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g,'');
  if (/(?:https?|ftp)\s*[:/]|www\s*[.\u3002\uff0e]|[a-z0-9]\s*(?:\.|\[dot\]|\(dot\)|\s+dot\s+)\s*(?:com|net|org|gg|io|xyz|app|dev|me|co|uk|us|edu|gov|tv|link|site|online|info|biz|club|shop|ru|de|fr|ca|au|jp|cn|in|it|nl|br|ly)\b/i.test(raw)) return 'website-link';
  if (/[a-z0-9-]+\.[a-z]{2,24}(?:\b|\/)/i.test(raw)) return 'website-link';
  if (/(?:^|\s)(?:yt|ig|tt)\s*[:@]\s*@?[a-z0-9_]/i.test(raw)) return 'contact-promotion';
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return 'contact-address';
  for (let i=0;i<CONTACT_BRANDS.length;i++) {
    const candidate=CONTACT_BRANDS[i]==='insta'?compact.replace(/(?:instant|instance|install|instability|winstanley)/g,' '):compact;
    if(CONTACT_PATTERNS[i].test(candidate))return 'contact-promotion';
  }
  if(HOMOGLYPH_ADULT_SITE_ALIASES.some(term=>compact.includes(normalizeNameForCheck(term).replace(/ /g,''))))return 'contact-promotion';
  const domainForm=normalizeNameForCheck(clean.replace(/[.。\uff0e]/g,' dot '));
  if(/\bdot\s+(?:com|net|org|gg|io|xyz|app|dev|me|co|uk|us|tv|link|site|online|info|biz|club|shop|ru|de|fr|ca|au|jp|cn|in|it|nl|br|ly)\b/.test(domainForm))return 'website-link';
  if (/(?:^|\s)(?:snap\s+me|my\s+snap|find\s+me\s+on\s+snap|hmu\s+on\s+snap)\b/.test(normalized) || /\bf4llow\s*me\b/.test(raw) || /(?:^|\s)(?:follow|subscribe|sub|add|dm|message|contact)\s*(?:me|my|to)\b/.test(normalized) || /(?:followme|subscribeto|addmeon|dmme|joinmy|usemycode|buyfollowers|freerobux|freevbucks|freerobucks|playinstead)/.test(compact) || /\bplay\b.+\binstead\b/.test(normalized)) return 'advertising';
  return '';
}

function withoutBenignMatches(compact,term){
  let candidate=compact;
  for(const word of BENIGN_EMBEDDED_WORDS[term]||[])candidate=candidate.replaceAll(word,' ');
  return candidate;
}

export function isRequestedBlockedName(value) {
  const clean = sanitizeDisplayName(String(value || '').replace(/[ϲϹ]/g,'c').replace(/Υ/g,'Y'));
  const compact = normalizeNameForCheck(clean).replace(/ /g, '');
  if (TARGETED_EXACT_NAMES.includes(compact)) return true;
  const rawCompact = clean.normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u0400-\u04ff\u3040-\u30ff\u4e00-\u9fff]/g, '');
  const suffixLength = rawCompact.match(/\d+$/)?.[0]?.length || 0;
  for (let length = 1; length <= Math.min(6, suffixLength); length += 1) {
    const prefix = normalizeNameForCheck(rawCompact.slice(0, -length)).replace(/ /g, '');
    if (TARGETED_EXACT_NAMES.includes(prefix)) return true;
  }
  return false;
}

export function moderatePublicName(value) {
  const clean = sanitizeDisplayName(value);
  const comparison = sanitizeDisplayName(String(value || '').replace(/[ϲϹ]/g,'c').replace(/Υ/g,'Y'));
  const normalized = normalizeNameForCheck(comparison);
  const tokens = normalized.split(' ').filter(Boolean);
  const compact = tokens.join('');
  const decision = (blocked, reason = '', match = null) => ({ blocked, reason, clean, match });
  const detail = (type, term, normalizedValue = normalized) => ({ type, term, normalized: normalizedValue });
  if (isRequestedBlockedName(value)) return decision(true, 'targeted-exact-name', detail('targeted-exact-name', compact));
  const promotion=promotionMatch(comparison,normalized,compact);
  if(promotion)return decision(true,'promotion',detail('promotion',promotion));
  const political=POLITICAL_IDENTIFIERS.find(term=>compact.includes(term));
  if(political||tokens.some(token=>POLITICAL_TOKENS.has(token)))return decision(true,'political-reference',detail('political-reference',political||tokens.find(token=>POLITICAL_TOKENS.has(token))));
  if(/^n[i1][!|]{2}er$/i.test(clean.replace(/\s+/g,'')))return decision(true,'obfuscated-unsafe-word',detail('obfuscated-unsafe-word','slur-mask',compact));
  for (const reserved of PREPARED_RESERVED_NAMES) {
    if (compact === reserved) return decision(true, 'reserved-name', detail('reserved-name', reserved));
  }
  const contextual=contextualNameMatch(comparison);
  if(contextual)return decision(true,'contextual-unsafe-phrase',detail('contextual-unsafe-phrase',contextual.term,contextual.normalized));
  if(BENIGN_EXACT_NAMES.has(compact))return decision(false);
  for (const term of PREPARED_NAME_TERMS) {
    if (term.phrase && normalized.includes(term.value)) return decision(true, 'unsafe-phrase', detail('unsafe-phrase', term.value));
    if (!term.phrase && tokens.includes(term.value)) return decision(true, 'unsafe-word', detail('unsafe-word', term.value));
  }
  const forms=[compact,compact.replace(/([a-z])\1{2,}/g,'$1'),compact.replace(/([a-z])\1{2,}/g,'$1$1')];
  for(const form of forms){
    const unwrapped=form.startsWith('x')&&form.endsWith('x')?form.replace(/^x+|x+$/g,''):form;
    if(unwrapped!==form&&PREPARED_NAME_TERMS.some(term=>term.value.replace(/ /g,'')===unwrapped))return decision(true,'unsafe-compound',detail('unsafe-compound',unwrapped,form));
    if(CLEAR_SLUR_ALIASES.test(form))return decision(true,'obfuscated-unsafe-word',detail('obfuscated-unsafe-word','slur-alias',form));
    for(const rule of PREPARED_EMBEDDED_RULES){
      const candidate=withoutBenignMatches(form,rule.term);
      if(rule.pattern.test(candidate))return decision(true,'unsafe-compound',detail('unsafe-compound',rule.term,form));
    }
    if(/(?:is|isa|iam|im|youare|ur)pedo(?:$|[^a-z])/.test(form))return decision(true,'unsafe-compound',detail('unsafe-compound','sexual-abuse-reference',form));
  }
  if(/(?:18\s*(?:\+|plus)|adult)[\s_.-]*(?:content|videos|chat|nudes|sex)/i.test(clean))return decision(true,'unsafe-compound',detail('unsafe-compound','adult-content-promotion'));
  if(/(?:send|dm|hmu|trade|sell|buy|free)(?:me)?n[o0]{2}d[z5s]/.test(compact))return decision(true,'unsafe-compound',detail('unsafe-compound','noods-solicitation',compact));
  for (const needle of PREPARED_SEVERE_NEEDLES) {
    const severeEmbedded = UNAMBIGUOUS_EMBEDDED_TERMS.has(needle);
    const candidate=withoutBenignMatches(compact,needle);
    if (candidate.includes(needle) && (severeEmbedded || candidate === needle || candidate.startsWith(needle) || candidate.endsWith(needle))) {
      return decision(true, 'obfuscated-unsafe-word', detail('obfuscated-unsafe-word', needle, compact));
    }
  }
  return decision(false);
}
// Mixed-radix indexing reaches every expanded pair without correlated selectors.
export const generatedNameStats = Object.freeze({firstWords: PROFILE_NAME_WORD_A.length,
  secondWords: PROFILE_NAME_WORD_B.length, combinations: PROFILE_NAME_WORD_A.length * PROFILE_NAME_WORD_B.length});

export function generatedNameAt(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= generatedNameStats.combinations) {
    throw new RangeError('Generated name index is out of range');
  }
  return PROFILE_NAME_WORD_A[Math.floor(index / PROFILE_NAME_WORD_B.length)] +
    PROFILE_NAME_WORD_B[index % PROFILE_NAME_WORD_B.length];
}

export function generatePublicName(seed) {
  const hash = Array.from(String(seed || 'racer')).reduce((acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0, 5381);
  return generatedNameAt(hash % generatedNameStats.combinations);
}

// Preserve legacy account-specific aliases. Expanded words are for NEW defaults only.
export function generateFallbackName(seed) {
  const hash = Array.from(String(seed || 'racer')).reduce((acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0, 5381);
  return PROFILE_NAME_WORD_A[hash % 93] + PROFILE_NAME_WORD_B[Math.floor(hash / 13) % 94];
}

export function safePublicName(value, accountId = '') {
  const decision = moderatePublicName(value);
  return decision.blocked ? (generateFallbackName(accountId || decision.clean) || 'Guest') : decision.clean;
}

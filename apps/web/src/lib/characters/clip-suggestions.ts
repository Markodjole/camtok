/**
 * Curated clip-creation ideas per canonical character slug.
 * Structure: each LOCATION has SETUPS (what happens there); each setup has CLIFFHANGERS that fit.
 * Written for Kling: one environment, 1–2 readable motions, natural 6–10s pacing, dilemma end.
 */

export type CharacterSceneSetup = {
  description: string;
  cliffhangers: string[];
};

export type CharacterSceneAtLocation = {
  location: string;
  setups: CharacterSceneSetup[];
};

export type CharacterClipSuggestions = {
  scenes: CharacterSceneAtLocation[];
};

const EMPTY: CharacterClipSuggestions = { scenes: [] };

/** Locations only (for location field). */
export function listLocations(s: CharacterClipSuggestions): string[] {
  return s.scenes.map((x) => x.location);
}

/** Setups whose parent location matches `locationText` exactly (use after picking from ideas). */
export function setupsForLocation(
  s: CharacterClipSuggestions,
  locationText: string,
): CharacterSceneSetup[] {
  const t = locationText.trim();
  if (!t) return [];
  const g = s.scenes.find((x) => x.location === t);
  return g?.setups ?? [];
}

export function descriptionsForLocation(s: CharacterClipSuggestions, locationText: string): string[] {
  return setupsForLocation(s, locationText).map((u) => u.description);
}

export function cliffhangersForLocationAndDescription(
  s: CharacterClipSuggestions,
  locationText: string,
  descriptionText: string,
): string[] {
  const d = descriptionText.trim();
  if (!d) return [];
  const setup = setupsForLocation(s, locationText).find((u) => u.description === d);
  return setup?.cliffhangers ?? [];
}

function loc(location: string, setups: CharacterSceneSetup[]): CharacterSceneAtLocation {
  return { location, setups };
}

export const CLIP_SUGGESTIONS_BY_SLUG: Record<string, CharacterClipSuggestions> = {
  nina: {
    scenes: [
      loc("Quiet corner office at dusk, city lights through glass", [
        {
          description:
            "A colleague slides a printed deck across the polished table; Nina has not opened it yet and holds her pen still over her notes.",
          cliffhangers: [
            "Two versions of the same cover page are visible in the stack; her thumb rests between them without lifting either.",
            "Her name is called softly from the corridor behind glass; she has not turned her chair.",
            "The city lights blink once in the glass; the reflection hides whether someone is standing in her doorway.",
          ],
        },
        {
          description:
            "An urgent banner lights her phone on the desk; she sets it face-down and exhales, both palms flat on the wood.",
          cliffhangers: [
            "The phone vibrates once more underneath; she has not flipped it.",
            "A second device on the credenza lights with the same sender; she stares at the gap between the two screens.",
            "Rain begins to streak the window behind her merger chart; her finger stops mid-line on the printout.",
          ],
        },
      ]),
      loc("Hotel lobby with low marble and a single reception desk", [
        {
          description:
            "A suited guest and the concierge disagree in low voices about a reservation; Nina stands aside with her rolling bag handle in one hand, listening.",
          cliffhangers: [
            "The clerk slides two key cards forward on the counter; neither matches the name she expected.",
            "Her booking confirmation is on her phone beside a printed slip that shows a different floor.",
            "Glass doors behind her reflect two figures approaching; she has not stepped forward to the desk.",
          ],
        },
        {
          description:
            "Her phone shows a calendar overlap — two meetings, same hour; she reads it standing beside a tall vase of lilies.",
          cliffhangers: [
            "Both invites show the same building but different suite numbers; she has not tapped accept on either.",
            "A bellhop offers to take her bag north or south tower; the luggage tag still shows neither checked.",
            "A familiar voice says her name from the seating area; she has not pivoted to see who.",
          ],
        },
      ]),
      loc("Conference room before anyone else arrives, projector idle", [
        {
          description:
            "She arranges three clickers and a cable at the head of the table; the screen stays blank and the door behind her is ajar.",
          cliffhangers: [
            "The projector suddenly wakes to an unfamiliar deck title; her hand hovers above the remote without pressing.",
            "Footsteps pause in the hallway; two different voices disagree about which room is free.",
            "A sticky note on the chair reads a name that is not hers; she has not sat down.",
          ],
        },
        {
          description:
            "Someone leaves a sealed envelope centered on the presenter chair; Nina reads the handwriting without touching it.",
          cliffhangers: [
            "The envelope has two different postmarks visible through the flap corner; she has not lifted it.",
            "Her phone shows a message: do not open until the room fills; attendees are not here yet.",
            "The door latch clicks as if someone tried the handle; she remains standing behind the chair.",
          ],
        },
      ]),
      loc("Upscale café window seat, rain faint on glass", [
        {
          description:
            "She pauses mid-sip as her name floats from the barista counter; steam rises between her and the crowded queue.",
          cliffhangers: [
            "Two drinks sit waiting with nearly identical sleeves; her name is on both stickers.",
            "Someone at the counter turns with a half-smile, holding a cup that could be hers or theirs.",
            "Rain smears a reflection over her phone screen; she has not unlocked it.",
          ],
        },
        {
          description:
            "A former collaborator slides into the seat across without asking, folder damp from the rain.",
          cliffhangers: [
            "The folder is labeled with a project she thought closed; she has not opened the cover.",
            "Their phone slides halfway across the table showing a calendar invite; accept and decline both visible.",
            "Behind them, through the glass, a car pulls up with two people inside; neither door has opened.",
          ],
        },
      ]),
      loc("Airport gate lounge, rows of empty seats, one screen flashing", [
        {
          description:
            "The departure board flips her flight to delayed then boarding; she stands slowly with her passport and boarding pass loose in one hand.",
          cliffhangers: [
            "Two gates show the same city with different times; she has not stepped toward either corridor.",
            "An announcement garbles the final syllable of the destination; the screen corrects to another code.",
            "A second boarding group is called while her ticket still shows group one; she has not joined the line.",
          ],
        },
        {
          description:
            "Security paging uses her middle name only; she rises from the plastic seat as others glance up.",
          cliffhangers: [
            "The nearest desk points left for re-screening, right for customer service; she has not moved toward either sign.",
            "Her bag strap catches on the armrest; the gate agent is already waving the next passenger.",
            "Two officers stand at the fork in the corridor; neither has gestured which way yet.",
          ],
        },
      ]),
      loc("Rooftop terrace with planters, wind moving papers on a low table", [
        {
          description:
            "Wind lifts one page from a stapled report; she presses it with her palm while skylines flicker in late sun.",
          cliffhangers: [
            "The loose page is numbered from a different appendix than the rest; she has not realigned the stack.",
            "Her phone shows a text: wrong terrace—other building; the stair doors behind her are identical on both sides.",
            "A second voice calls up from the stairwell, climbing; she has not answered which floor she is on.",
          ],
        },
        {
          description:
            "Someone joins her at the rail without speaking, both watching traffic far below.",
          cliffhangers: [
            "They place two business cards side by side; the logos almost match but the suffixes differ.",
            "Her phone buzzes with a location share pin dropped on this block; three buildings share the outline.",
            "Rain begins over the river only, a straight shadow line moving toward the terrace.",
          ],
        },
      ]),
      loc("Law library reading table, tall shelves and green lamps", [
        {
          description:
            "Two volumes with almost the same spine title sit open; she compares indices with one finger on each page.",
          cliffhangers: [
            "One citation paragraph contradicts the other on the same precedent; she has not closed either book.",
            "A bookmark ribbon slips out dated last week; someone else's note peeks behind it, unread.",
            "The lamp flickers; the after-hours bell has not rung but the aisle feels occupied.",
          ],
        },
        {
          description:
            "A clerk whispers that the volume she needs was pulled for a partner; it is sitting on a cart ten feet away beside another similar spine.",
          cliffhangers: [
            "Both spines share the same volume number; only the edition year differs on the bottom.",
            "The cart rolls slightly on the sloped floor; neither book has slid but both shift a millimeter.",
            "Her signing sheet asks room or takeaway; the pen skips ink on the first stroke.",
          ],
        },
      ]),
      loc("Boutique hotel corridor, soft carpet, numbered doors", [
        {
          description:
            "Her key envelope shows 412; the brass numbers on the nearest door read 412 with a fresh screw beside a faint outline of a former digit.",
          cliffhangers: [
            "The next door reads 412 as well around the corner; both keycards sit in her palm.",
            "Housekeeping's cart blocks one end of the hall; voices laugh behind the farthest door.",
            "The key light blinks red then green; she has not pressed it into the slot.",
          ],
        },
        {
          description:
            "An envelope under her door is addressed with her firm, not her name; she nudges it with her shoe without picking it up.",
          cliffhangers: [
            "A second envelope identical dimensions slides under the opposite door; both corners show different colored wax.",
            "Her phone maps the floor plan rotated ninety degrees from the wall plaque.",
            "Footsteps approach from the stairwell and the elevator ding at the same time.",
          ],
        },
      ]),
    ],
  },

  lila: {
    scenes: [
      loc("Denim wall at a bright clothing store, folded stacks and size tags", [
        {
          description:
            "Two cuts hang on the same hook labeled one size; Lila holds both waistbands against her hips, switching them back and forth slowly.",
          cliffhangers: [
            "A third pair appears on the high shelf with a handwritten tag that could read 28 or 26 fold.",
            "Her phone buzzes with a photo of the darker wash she already put back; the message says definitely those.",
            "A sale sticker half-peels to reveal last week's price lower than today's discount.",
          ],
        },
        {
          description:
            "A staff member offers to start a fitting room while her arms are already full of three different blues.",
          cliffhangers: [
            "Only two hooks are free behind curtains that both say occupied; she has not knocked.",
            "The staff badge name matches her friend's sister; she has not confirmed out loud.",
            "The pile in her arms slips; something tags her sleeve she did not grab.",
          ],
        },
      ]),
      loc("Sneaker aisle with mirrors along the floor", [
        {
          description:
            "Three boxes sit at her feet; she lifts one lid, then another, unable to settle.",
          cliffhangers: [
            "The mirror duplicates a fourth size sticker she did not pull off any box.",
            "Her reflection and the shelf behind disagree on which color is brighter under the LEDs.",
            "A child runs past; one box rocks toward the glass without her hand on it.",
          ],
        },
        {
          description:
            "Her phone shows a text: get the green one; green and teal sit side by side under the same model name.",
          cliffhangers: [
            "The app photo she saved is closer to teal; the caption says green.",
            "Stock app claims one pair in back; the associate pauses with two identical boxes in hand.",
            "Checkout ping sounds on her watch for an online cart while she holds physical inventory.",
          ],
        },
      ]),
      loc("Thrift store jacket rack, plastic hangers crowded", [
        {
          description:
            "She finds a jacket with the patch she wanted but a stain near the cuff; she turns the sleeve slowly toward the window light.",
          cliffhangers: [
            "Behind it on the rack hangs the same jacket clean, one size up with a torn lining.",
            "The price tag shows half off today and full price tomorrow written in two different inks.",
            "Someone else's hand reaches for the same shoulder without seeing her grip.",
          ],
        },
        {
          description:
            "A velvet collar catches her eye; the zipper is stuck halfway and squeaks when she tries it once.",
          cliffhangers: [
            "The next hanger has a tailor's receipt in the pocket dated yesterday.",
            "The store speaker announces closing while she has not decided try-on or buy as-is.",
            "A mirror at the end of the aisle shows someone filming hangers; she has not let go.",
          ],
        },
      ]),
      loc("Mall food court table with shopping bags piled", [
        {
          description:
            "Friends slide trays down; she still zips a bag closed over one last purchase, chopsticks unused beside foam soup.",
          cliffhangers: [
            "Two receipts show conflicting return windows for the same store name.",
            "Her drink tab has two straws poked; neither cup is hers yet.",
            "A phone airdrop request pops with no name; the preview thumbnail is a mall map.",
          ],
        },
        {
          description:
            "A mall security guard pauses near her table asking if she left something at a store she's never entered.",
          cliffhangers: [
            "The item they describe matches something in her bag she did not buy.",
            "Their radio crackles two store numbers; she has not stood to follow.",
            "Her friends argue whether the guard's badge is real or film promo.",
          ],
        },
      ]),
      loc("Dressing room area, curtain half open on an empty stall", [
        {
          description:
            "She clutches two sizes waiting as both curtains stay closed; feet visible under one do not match her friend's shoes.",
          cliffhangers: [
            "A hand waves her into a third stall that was locked a minute ago.",
            "Her phone timer for the meetup hits zero while both occupied signs still show red.",
            "Something drops over the divider: wrong color garment for what she held.",
          ],
        },
        {
          description:
            "She steps out in one outfit; the mirror beside the exit reflects a sale mannequin wearing the rival color she almost picked.",
          cliffhangers: [
            "The tag on the mannequin says one day only; her receipt time stamp is unreadable smudge.",
            "Her friend appears behind her with bags from the rival store entrance.",
            "The curtain she chose rattles on the rod; someone else's belt is looped on her hook.",
          ],
        },
      ]),
      loc("Accessory wall with rows of sunglasses and caps", [
        {
          description:
            "She tries a cap forward and backward in the mirror, chin tilted, neither look fully chosen.",
          cliffhangers: [
            "A security tether on the glasses rack tangles with the cap brim in her hand.",
            "Her reflection shows a second mirror angle where the cap color reads different.",
            "A friend texts a selfie wearing the same cap brand; wrong logo embroidery visible.",
          ],
        },
        {
          description:
            "Polarized pairs look identical until she tilts them toward the ceiling lights; price doubles on one tiny sticker.",
          cliffhangers: [
            "The case that fits only the expensive pair sits open empty on the shelf below.",
            "UV sticker peels on one lens but not the other; return policy sign is backward.",
            "Checkout line forms behind her while she still holds three on her face.",
          ],
        },
      ]),
      loc("Checkout line with impulse-buy bins on both sides", [
        {
          description:
            "The register beeps for her first item; she realizes a second top is still tucked under the first on the belt.",
          cliffhangers: [
            "The cashier asks one price or bundle; the screen shows a third number flashing.",
            "Her wallet sits between phone pay and cash back buttons on the terminal.",
            "The person behind clears their throat as a manager key is requested.",
          ],
        },
        {
          description:
            "Chip reader declines once; she has not tried the second card while the line compresses.",
          cliffhangers: [
            "The screen suggests contact bank or retry; both buttons glow the same hue.",
            "A cart behind carries the last display model of something she almost added.",
            "Her phone wallet offers two linked cards with identical last digits.",
          ],
        },
      ]),
      loc("Vintage band tee section, crates and cardboard signs", [
        {
          description:
            "Two tees share the same tour year in different fades; she compares neck tag stitching under the weak bulb.",
          cliffhangers: [
            "A third shirt from the crate shows the same concert date spelled wrong on the print.",
            "The seller says one is repro without specifying which table half.",
            "Her size is on a mannequin across the aisle facing away.",
          ],
        },
        {
          description:
            "Dust motes float as she lifts a crate lid; something taped inside crackles like plastic over another shirt.",
          cliffhangers: [
            "The tape date is today's market day; the shirt below is still folded retail.",
            "A vendor claims first pick on anything she lifts; handshake not completed.",
            "Rain starts on the tent roof; half the crates have no lids.",
          ],
        },
      ]),
    ],
  },

  earl: {
    scenes: [
      loc("Ranch porch with rocking chairs and heat shimmer", [
        {
          description:
            "Thunder rolls; Earl lowers his newspaper one inch while cigar ash holds steady, truck keys and coffee mug each on opposite armrests.",
          cliffhangers: [
            "The first fat raindrop hits the tin roof left channel or right; he has not shifted toward either chair.",
            "The gate latch clinks down the gravel; no vehicle sound follows yet.",
            "His flip phone vibrates once with no name; the coffee steam still rises.",
          ],
        },
        {
          description:
            "A grandkid holds up a tablet asking streaming or cable; the old remote sits between them on wood worn smooth.",
          cliffhangers: [
            "Both devices show different local channel numbers for the same game.",
            "The dog's tail thumps once under his rocker; the kid has not tapped either icon.",
            "Lightning brightens the yard; something moves at the fence line the dog does not bark at.",
          ],
        },
      ]),
      loc("Gas station pump island, concrete and distant highway", [
        {
          description:
            "Two pumps show different cents per gallon for regular; his truck cap is open, nozzle still on the hook.",
          cliffhangers: [
            "Reward card screen asks verify before pump; wallet thick, not opened.",
            "Diesel handle swings closer in wind; his hand is midway between grades.",
            "A voice behind offers to fill while he rests; hat brim hides whether he turned.",
          ],
        },
        {
          description:
            "Receipt printer jams after total; zeros visible on the sticky preview, last digit missing line.",
          cliffhangers: [
            "Clerk slides corrected handwritten total on tape; keypad still shows the first try.",
            "Pump auto-stops early; gallon count does not match price board mental math.",
            "Semi horn on highway; his foot has not left the concrete island edge.",
          ],
        },
      ]),
      loc("Hardware store paint aisle, fan decks and metal shelves", [
        {
          description:
            "Clerk offers tablet color match; paper fan deck is on the counter beside a bucket ringed with old price stickers.",
          cliffhangers: [
            "Screen sample and paper chip look different under fluorescent vs window strip.",
            "Two gallons wait labeled same name different bases; neither lid opened.",
            "Intercom calls paint desk extension twice with two voices.",
          ],
        },
        {
          description:
            "He lifts a gallon tester; drip on floor matches neither swatch he holds.",
          cliffhangers: [
            "Cleanup signs point mop bay or spill kit; both aisles end in pallets.",
            "Associate suggests accent quart free with gallon; receipt tablet shows charge pending.",
            "Phone photo of barn door in pocket; lighting on phone differs from store.",
          ],
        },
      ]),
      loc("Small-town diner booth, laminate table and window glare", [
        {
          description:
            "Server offers sugar-free pie slice; his fork hovers over his own full-sugar slice cooling steam.",
          cliffhangers: [
            "Coffees refill spout drips between his mug and hers across the booth.",
            "Window glare clears; a cruiser slows outside with lights not yet on.",
            "Menu flip side lists same pie different crust note in pencil.",
          ],
        },
        {
          description:
            "Two hunters debate cartridge brands across the counter; Earl listens, thumb on belt loop, coffee untouched.",
          cliffhangers: [
            "Both slide boxes toward him for tie-break without asking.",
            "Door chime rings; boots pause on mat not entering.",
            "His pie fork taps once; clock above grill loses a second hand tick.",
          ],
        },
      ]),
      loc("Bait shop counter, Styrofoam coolers stacked", [
        {
          description:
            "Kid asks which bait for lake versus river; two tubs sit unlabeled except faint marker.",
          cliffhangers: [
            "Owner says trust smell; both lids crack open a breath apart.",
            "Rain starts on metal roof; tournament weigh-in time on wall chalk behind.",
            "Credit card reader asks tip on worms; screen waits.",
          ],
        },
        {
          description:
            "Stray dog approaches his boots; he does not move the cigar, eyes on a collar without tag.",
          cliffhangers: [
            "Second dog appears from cooler aisle tail low, no sound.",
            "Kid offers half a sandwich; meat type disagrees with sign on wall.",
            "Owner says town ordinance leash or fine; clock behind counter wrong by hour.",
          ],
        },
      ]),
      loc("Feed store loading area, pallets and shade", [
        {
          description:
            "Two pallet stacks same product different lot codes; he reads tiny print in shade while loader idles.",
          cliffhangers: [
            "Driver says only one stack is sale price today; stickers partially sun-faded.",
            "Invoice in hand shows third lot number not on pallets visible.",
            "Dust devil spins between stacks; neither top bag shifts yet.",
          ],
        },
        {
          description:
            "He weighs lifting 50lb alone; young hand offers help from each side of the flatbed.",
          cliffhangers: [
            "Neither helper wears store vest; both have gloves on.",
            "Strap ratchet clicks once; bag handle tears thread without breaking.",
            "Radio weather alert cuts music; hail possible line crosses map corner.",
          ],
        },
      ]),
      loc("Barber shop waiting bench, trophy fish on the wall", [
        {
          description:
            "Barber asks same as usual; wall photo fade looks decades-old while mirror shows today's clippers charging.",
          cliffhangers: [
            "Two guard numbers sit on the counter; neither matches last visit mental note.",
            "Walk-in opens door; barber raises finger one more chair or wait signal unclear.",
            "Phone in lap buzzes family group photo ID; cape not snapped yet.",
          ],
        },
        {
          description:
            "Magazine page stuck to knee from humidity; headline about land auction catches his eye mid-wait.",
          cliffhangers: [
            "Property map on page folds wrong county line over correct parcel shape.",
            "Other customer recognizes him from rumor only; handshake half offered.",
            "Clock ticks loud then silent two beats.",
          ],
        },
      ]),
      loc("Courthouse steps in harsh midday sun", [
        {
          description:
            "He reads a folded notice with two times printed for the same case number.",
          cliffhangers: [
            "East entrance guard points left wing; west says courtroom moved overnight.",
            "Shadow of flagpole cuts his shoes between two step cracks.",
            "Someone calls a name similar to his middle from the top riser.",
          ],
        },
        {
          description:
            "Bench gravel crunches behind; lawyer's business card is offered with a second card slipped beneath.",
          cliffhangers: [
            "Second card is blank back except a phone number area code split state line.",
            "Courthouse doors lock buzz early on schedule board crossed out.",
            "Cloud line splits sun on his face half-and-half.",
          ],
        },
      ]),
    ],
  },

  viktor: {
    scenes: [
      loc("Curbside beside a vintage car, hood cool in shade", [
        {
          description:
            "Two drivers argue over the angled parking slip; Viktor stands beside his own car, keys slow-rotating on one finger.",
          cliffhangers: [
            "Paint scrape height on concrete wall matches neither bumper yet.",
            "Security cart turns corner; neither driver looks toward it.",
            "His phone vibrates twice same contact different icons.",
          ],
        },
        {
          description:
            "Second keyring visible on driver's seat through glass; door sticks on first pull.",
          cliffhangers: [
            "Alarm chirp pattern wrong sequence; thumb on fob not pressed.",
            "Alley voice calls name not his; shoulder turns halfway.",
            "Sun breaks cloud; reflection blinds plate read attempt.",
          ],
        },
      ]),
      loc("Corner store with a security mirror above the register", [
        {
          description:
            "Change hits the counter; his palm stays flat while clerk waits, neon beer sign hum in the edge of vision.",
          cliffhangers: [
            "Register drawer opens two denomination slots empty.",
            "Mirror shows doorway shape shifting without door sound.",
            "Lottery screen flashes jackpot replay older timestamp.",
          ],
        },
        {
          description:
            "Someone slides folded bills early for a pack behind glass; he watches the clerk's eyes, not the money.",
          cliffhangers: [
            "ID scanner beeps invalid twice; line compresses at his back.",
            "Cooler door fog clears on wrong brand row highlighted.",
            "Phone wallet suggests split pay bar stuck halfway.",
          ],
        },
      ]),
      loc("Stairwell landing, graffiti and a single bare bulb", [
        {
          description:
            "Two staircases branch up; one bulb dead, graffiti arrow points faintly both ways.",
          cliffhangers: [
            "Echo of footsteps from above does not match rhythm descending faintly below.",
            "His boot toe stops one inch short of a fresh wet mark.",
            "Phone map rotates corridor overlay wrong ninety degrees.",
          ],
        },
        {
          description:
            "Friend leans from upper rail offering shortcut through roof door or basement exit.",
          cliffhangers: [
            "Roof alarm LED sleeps dark; basement sign says wet floor partial letters.",
            "Carried bag strap slips notch; both hands busy with phone map.",
            "Voice from his floor calls nickname variant not quite his.",
          ],
        },
      ]),
      loc("Late-night food truck queue, steam and string lights", [
        {
          description:
            "Cash slides through early window slot ahead of order called; he watches the cook's pause on spatula.",
          cliffhangers: [
            "Menu flip removes item he queued for; chalk cross-out fresh.",
            "Two order numbers sound similar over speaker static.",
            "Card reader taped over but sign says cash preferred tonight.",
          ],
        },
        {
          description:
            "His phone shows live location dot moving toward pin; screen unlocked thumb hovers lock.",
          cliffhangers: [
            "Dot pauses alley mouth not truck coordinates.",
            "Second share link opens same map different ETA minute.",
            "Steam wipes his glasses; queue steps forward without him.",
          ],
        },
      ]),
      loc("Underground parking column, tire marks and echo", [
        {
          description:
            "Dog chain rattles fence behind vent; he stops mid-step one foot half off safety stripe.",
          cliffhangers: [
            "Shadow tail wag silhouette without bark sound.",
            "Pillar number plaque mismatched painted column stencil.",
            "Alarm chirp distant three floors echo cancels direction.",
          ],
        },
        {
          description:
            "Offered ride north or south; passenger door open, engine idle low.",
          cliffhangers: [
            "Dashboard GPS shows third destination cached.",
            "Rear seat bag not his usual color lump.",
            "Parking gate arm drops early behind blocking reverse.",
          ],
        },
      ]),
      loc("Outdoor basketball court, chain-link and one hoop lit", [
        {
          description:
            "Pickup game debate who had next; ball rolls to his toe at three-point arc.",
          cliffhangers: [
            "Both teams jerseys same color under sodium light.",
            "Phone timer runs overtime bet; neither captain looks at it.",
            "Second ball drops from darkened bleachers without throw visible.",
          ],
        },
        {
          description:
            "Scraped knuckle bleeds slow; two people offer paper towels from left and right.",
          cliffhangers: [
            "Towel prints differ logo community center vs gym chain.",
            "Whistle mouth far sideline not in ref shirt.",
            "Scoreboard flickers home guest swap digits once.",
          ],
        },
      ]),
      loc("Bar doorway with neon spill on wet sidewalk", [
        {
          description:
            "Neon reflects red then blue on wet pavement; he does not turn head, breath slower.",
          cliffhangers: [
            "Siren doppler peaks without vehicle passing visible gap.",
            "Bouncer radio static name fragment like his.",
            "Door suction pulls his shoulder not forward enough to enter.",
          ],
        },
        {
          description:
            "Buddy offers handshake or fist bump; arms lift slightly mirrored freeze.",
          cliffhangers: [
            "Music bass drops mask next word request.",
            "Rain thin stripe under awning dry half his shoulder only.",
            "ID in wallet corner catches neon strip UV reaction.",
          ],
        },
      ]),
      loc("Pawn shop glass counter, items layered behind", [
        {
          description:
            "Two watches identical faces different serial cards; loupe not yet lifted.",
          cliffhangers: [
            "Owner taps glass over third watch shadow blocked.",
            "Offer slips slide under counter glass each different last digit.",
            "Door bell rings; reflection overlays stranger behind him.",
          ],
        },
        {
          description:
            "Rain makes taped poster run; he blinks reread address digits once wrong.",
          cliffhangers: [
            "QR soggy segment three orientation attempts fail.",
            "Walk sign flickers without chirp box audible.",
            "Keys jingle wrong pitch pocket pat incomplete.",
          ],
        },
      ]),
    ],
  },

  baxter: {
    scenes: [
      loc("Training field bleachers, empty metal rows", [
        {
          description:
            "Rain patch crawls across dry turf; schedule clipboard says hold; his watch second hand ticks once audible.",
          cliffhangers: [
            "Alternative field text arrives mid-hold conflicting minute.",
            "Lightning count not started finger hover chest.",
            "Private drops canteen between boots roll; he has not shifted retrieve.",
          ],
        },
        {
          description:
            "Two NCOs mention staggered times by three minutes for same formation name.",
          cliffhangers: [
            "Formation graphic on phone third time not matching either voice.",
            "Bleacher shadow crosses his face half sun half cloud line.",
            "Whistle on lanyard swing freezes mid arc wind pause.",
          ],
        },
      ]),
      loc("Briefing room with a map wall and chairs in rows", [
        {
          description:
            "Map pin lands between grid squares; fingertip traces fold paper valley not printed dot.",
          cliffhangers: [
            "Second map layer transparency slid halfway mismatches river ink.",
            "Door window shows silhouettes two ranks arguing gesture.",
            "Dry erase marker squeak stops mid label no cap replaced.",
          ],
        },
        {
          description:
            "New private salutes wrong hand; correction syllable hangs air not spoken yet.",
          cliffhangers: [
            "Other privates mirror error contagious half rise.",
            "Clock above map loses second tick two beats.",
            "Clipboards stack three different versions same op name.",
          ],
        },
      ]),
      loc("Chapel foyer before service, pamphlets and hush", [
        {
          description:
            "Two pamphlet stacks same title different revision dates corner tiny print.",
          cliffhangers: [
            "Usher offers both left right hand palm up equal height.",
            "Organ note holds unresolved chord through doorway crack.",
            "Boot heel echo merges second footfall not his cadence.",
          ],
        },
        {
          description:
            "Canteen strap adjusted one side left buckle only right slack equal length unselected.",
          cliffhangers: [
            "Reflection brass name plate dimmer than door plaque spelling.",
            "Phone silence switch visible pocket bump vibration once.",
            "Flower arrangement petal falls mid reach pamphlet.",
          ],
        },
      ]),
      loc("Armory check-in desk, clipboard and key hooks", [
        {
          description:
            "Red pen black pen clip same board; weather door propped one inch both temps fog glass.",
          cliffhangers: [
            "Key tag pair same rack letter different color tape.",
            "Roster line smudged rank unreadable finger hovers print.",
            "Radio scratch voice repeats word cut static.",
          ],
        },
        {
          description:
            "Phone buzzes family photo ID; formation window under two minutes pocket seam flat.",
          cliffhangers: [
            "Text preview says ignore conflicting voicemail duration visible.",
            "Key hook empty slot his usual number placard rotated backward.",
            "Boot print mat mud fresh only left sole pattern.",
          ],
        },
      ]),
      loc("Barracks aisle, footlockers and thin mattresses", [
        {
          description:
            "Glove fits left not right; spare locker twenty meters latch clicked interior unknown.",
          cliffhangers: [
            "Name tape half peeled neighbor locker almost his spelling.",
            "Fire watch board two names one slot dry erase smear.",
            "Fluorescent buzz aligns heartbeat then off phase beat.",
          ],
        },
        {
          description:
            "Helmet strap dangles wind lifts brim thumb width adjust not buckle commit.",
          cliffhangers: [
            "Shadow figure bunk end sits up sheet motionless silhouette.",
            "Boot lace one eyelet skipped visible only right boot.",
            "Overhead speaker test tone no follow message.",
          ],
        },
      ]),
      loc("Motor pool vehicle line, hoods and chalk marks", [
        {
          description:
            "Chalk tire mark fresh crosses older diagonal; dispatch tablet shows vehicle row letter mismatch stencil.",
          cliffhangers: [
            "Keys on board two identical number tags different dings.",
            "Engine idle one bay rough one smooth same model line.",
            "Fuel gauge needle sun glare hides quarter tank truth.",
          ],
        },
        {
          description:
            "PMCS clipboard asks fluid check cap lines both yellow stickers new old adhesive ring.",
          cliffhangers: [
            "Second mechanic points hose routing diagram folded corner conflicting arrow.",
            "Horn tap accidental from adjacent row driver not visible.",
            "Cloud shadow line crosses hood temperature hand hover not landed.",
          ],
        },
      ]),
      loc("Obstacle course start line, chalk digits on gravel", [
        {
          description:
            "Whistle half-raised unclear lane assignment number or not yet gesture freeze.",
          cliffhangers: [
            "Timer display cable loose digit segment flicker.",
            "Starter drops flag string tangle toe not behind line commit.",
            "Drone hum overhead unauthorized shadow oval not moving.",
          ],
        },
        {
          description:
            "Ruck strap slack both sides left buckle adjusted once right untouched symmetry wait.",
          cliffhangers: [
            "Shadow official arm partial signal cut tree branch sway.",
            "Water bottle nozzle open drip first mud spot choice.",
            "Ear pro cord snag fence link sound behind.",
          ],
        },
      ]),
      loc("Memorial stone path, flags at half-mast", [
        {
          description:
            "Flag rope fray found inspection; clip rests palm eye on knot studying not pole lower.",
          cliffhangers: [
            "Second stone plaque revision year chisel fresh dust toe line.",
            "Mourner group approach two deep three wide unsure yield path.",
            "Wind gust half furl snap sound rope slap metal once.",
          ],
        },
        {
          description:
            "Night vision case latched battery bar red segment overhead bulb still courtroom bright leak doorway.",
          cliffhangers: [
            "Lens cloth offered left sterile right civilian fiber mix.",
            "Boot crunch gravel synchronizes distant gate hinge squeak.",
            "Moon cloud edge cuts bronze name letters half readable.",
          ],
        },
      ]),
    ],
  },

  malik: {
    scenes: [
      loc("Home kitchen at night, island light on, rest of house dark", [
        {
          description:
            "He compares two timers on phone and stove; one beeps soft, the other has not started, wooden spoon still in bowl.",
          cliffhangers: [
            "Oven window glow suggests wrong rack height shadow mismatch.",
            "Recipe card on tablet rotated upside down thumbnail micro font.",
            "Text from roommate says home in five oven already preheated past recipe.",
          ],
        },
        {
          description:
            "Last egg cracks; thumb catches shell fragment; compost and trash bins equally one step different directions.",
          cliffhangers: [
            "Shell slips toward sink drain slow spiral not committed rinse.",
            "Phone macro photo ping asks is this safe to eat thumbnail unclear yolk.",
            "Smoke thin thread from pan not his usual burner choice tonight.",
          ],
        },
      ]),
      loc("Busy brunch restaurant line kitchen, tickets on rail", [
        {
          description:
            "Two identical tickets same table different modifiers; he reads each word once spatula lifted not down.",
          cliffhangers: [
            "Expediter points left plate right plate same protein different sauce swirl.",
            "Allergen sticker half peeled both say nut free cross ink.",
            "Caller ID family name front house line rings once kitchen line.",
          ],
        },
        {
          description:
            "Customer modification mid-rail shout vegan swap; butter foam already film on his pan edge.",
          cliffhangers: [
            "Clean pan hook empty hook beside has slight warp shadow.",
            "Manager gesture slice continue versus restart pan silent mouth shape.",
            "Steam fogs pass window moment ticket face wrong table number last digit.",
          ],
        },
      ]),
      loc("Apartment building laundry room, washers thumping", [
        {
          description:
            "Two machines end cycle same minute; his basket sits between, hand on one lid not lifted.",
          cliffhangers: [
            "One machine sock color not his visible through glass wrong drum.",
            "Neighbor dryer sheet static cling his shirt shoulder unnoticed yet.",
            "Card reader laundry credit asks reload or one more cycle equal price.",
          ],
        },
        {
          description:
            "Folding table half cleared; someone left detergent pod squish in palm offer or trash.",
          cliffhangers: [
            "Label says HE only washer front load sign contradicted sharpie.",
            "Timer on phone overlaps gym class alarm same vibration pattern.",
            "Exit door window reflects hallway two people with keys not his floor.",
          ],
        },
      ]),
      loc("Night street basketball half-court, single floodlight", [
        {
          description:
            "Pickup tied argument last possession; ball rests on his toe at arc,arguments overlap two fouls claimed.",
          cliffhangers: [
            "Phone camera flash accidental from sideline blind half court.",
            "Chain net tangled ball wedge above rim shadow pulsing wind.",
            "Watch beep shift timer conflicts pickup win by two tradition call.",
          ],
        },
        {
          description:
            "Offered sub in next game water bottle trade brand unfamiliar cap seal ring broken unease.",
          cliffhangers: [
            "Bottle condensation handwriting sharpie initials not his crew.",
            "Second team jersey same number different font arguing eligibility.",
            "Car headlights swing gate open silhouette driver wave unclear invite.",
          ],
        },
      ]),
      loc("Music venue merch table after show, folding crates", [
        {
          description:
            "Last shirt size debate two buyers one shirt; he holds plastic between them prices taped fresh and old overlapping.",
          cliffhangers: [
            "Artist signature variant real on one tag sticker only.",
            "Square reader says sold out inventory app shows quantity one.",
            "Security earpiece crackle crowd surge back tunnel not visible.",
          ],
        },
        {
          description:
            "Cash count differs mental math by one bill fan breeze lifts corner stack.",
          cliffhangers: [
            "Two twenties serial close sequence drop counterfeit paranoia freeze.",
            "Venue lights half blackout merch only zone lit uneven.",
            "Friend texts meet east exit west exit venue map ambiguous arrow.",
          ],
        },
      ]),
      loc("Gym weight floor, mirrors and chalk dust", [
        {
          description:
            "Spotter asks five more or rerack now; bar at chest pause breath one rep ambiguous effort.",
          cliffhangers: [
            "Clip on bar wrong color sleeve mismatch safety question unspoken.",
            "Reflection lag LED mirror refresh shows bar millimeter lower true.",
            "Headphones dead battery vibrate silent alarm same pattern work call.",
          ],
        },
        {
          description:
            "Protein shaker lid cross-thread leak strip halfway sealed gym bag fabric darkening spot.",
          cliffhangers: [
            "Second identical shaker on bench initial sharpie letter close.",
            "Scale readout blinking low battery weight judgment call unrepeated.",
            "Text nutrition macro goal overshot undecided dump dilute split.",
          ],
        },
      ]),
      loc("Transit platform, train indicator flickering", [
        {
          description:
            "Board shows express and local same destination offset two minutes; he stands bag between yellow tiles toes not behind line.",
          cliffhangers: [
            "Vibration underfoot arrives early schedule app silent mode dropdown.",
            "Advertisement screen reflects platform opposite side train ghost image.",
            "Earbud one dead channel announcement only clear other muffled destination word.",
          ],
        },
        {
          description:
            "Someone drops wallet; he toe-stops slide without picking ID corner visible not his photo.",
          cliffhangers: [
            "Owner approaches from stairs elevator same instant distance tie.",
            "Second wallet pattern match mistake table lost found sign contradictory.",
            "Train door chime first car last car announcement overlap syllable.",
          ],
        },
      ]),
      loc("Community meeting hall folding chairs, coffee urn hiss", [
        {
          description:
            "Neighbors debate zoning slide two maps faint boundary ink; he holds paper cup steam unread label decaf regular.",
          cliffhangers: [
            "Microphone screech feedback chair row half stands sit gesture mixed.",
            "Clipboard signup email field smudged last letter domain guess.",
            "Exit sign LED flicker sync coffee urn valve hiss beat off phase.",
          ],
        },
        {
          description:
            "Sticky name tag curls; pen offers blue black identical barrels cap confusion polite delay.",
          cliffhangers: [
            "Name printed wrong one letter his common misspelling corrected or own.",
            "Donation jar two slots one labeled storm fund other unclear sharpie.",
            "Child tugs his sleeve parent unknown three faces toward refreshment table.",
          ],
        },
      ]),
    ],
  },

  darius: {
    scenes: [
      loc("Barbershop chair mid-fade, mirrors on both sides", [
        {
          description:
            "Barber holds two guard numbers at ear height; reflection doubles the choice in opposing angles.",
          cliffhangers: [
            "Photo on wall fade catalog decade mismatch mirror current clipper hum.",
            "Next chair client speaks language layering same cut name confusion polite smile freeze.",
            "Phone vibrates resale offer link shoes lacing ankle not his size question.",
          ],
        },
        {
          description:
            "Price board dry-erase smear last digit; Cape snaps at neck snap mid second click.",
          cliffhangers: [
            "Tip screen percent jump if card before cash decision thumb pad hover.",
            "Straight razor strop sound behind not his station peripheral trust test.",
            "Walk-in kid wants same lineup photo book page torn corner.",
          ],
        },
      ]),
      loc("Used car lot front line, windshield stickers sun-glare", [
        {
          description:
            "Two sedans same model mileage sticker $400 apart; sunglasses down nose read fine print warranty block.",
          cliffhangers: [
            "Sales key fob lights wrong adjacent row car beep confirmation absent.",
            "Carfax print corner coffee stain hides accident box yes no.",
            "Lot attendant points row letter conflicting stencil ground paint fade.",
          ],
        },
        {
          description:
            "Test drive loop merge; salesman talks warranty extension armrest paperwork folder two colors tabs.",
          cliffhangers: [
            "Brake feel soft first press second firm hill pause unspoken diagnostic.",
            "Radio preset station call-in contest cash now button glare.",
            "Rearview child seat buckle shadow not in listing photos earlier.",
          ],
        },
      ]),
      loc("Basketball court sidelines, weekend tournament", [
        {
          description:
            "Team tie last seconds; coach gestures substitution him versus cooling starter knee wrap loose.",
          cliffhangers: [
            "Scoreboard operator wrong bonus light on free throw incomplete explanation gesture.",
            "Ref whistle mouth unclear jump ball alternate possession arrow board delayed.",
            "Phone bet app notification lock screen visible friend shoulder glance.",
          ],
        },
        {
          description:
            "Half-court shot contest volunteer hat; ping pong ball draw number his jersey conflict already playing next.",
          cliffhangers: [
            "Sponsor banner prize fine print season ticket not cash thumb hover signature.",
            "Crowd wave phone flash pattern causes rim glare blind release timing.",
            "Ankle brace vendor tent same brand two prices event weekend only ambiguity.",
          ],
        },
      ]),
      loc("Costco-style warehouse aisle, high pallets and flat carts", [
        {
          description:
            "Bulk item two pallet positions lot codes differ; he reads stamp corner date while cart blocks traffic polite half smile.",
          cliffhangers: [
            "Sample station beeper tongs same item sauce variant unmarked tray edge.",
            "Membership scan secondary card spouse points balance split pay bar freeze.",
            "Overhead flat moves forklift shadow crosses his lane pause step.",
          ],
        },
        {
          description:
            "Compare unit price ounce versus each sign mismatch calculator phone app battery percent low.",
          cliffhangers: [
            "Cash back kiosk line longer than checkout returns desk arrow confusing.",
            "Freezer door fog reveals second brand behind first identical packaging colorway.",
            "Receipt printer offer survey code entry expires midnight timezone unclear.",
          ],
        },
      ]),
      loc("Outdoor summer block party, grill smoke and folding tables", [
        {
          description:
            "Two cousins debate charcoal chimney gas side burner; he holds tongs over tray not placed.",
          cliffhangers: [
            "Last platter space one protein choice ribs versus brisket both tables reach same instant.",
            "Neighbor offers homemade sauce unlabeled heat level spoon hover lip test not taken.",
            "Music playlist skip phone connected speaker wrong household Wi-Fi name visible list.",
          ],
        },
        {
          description:
            "Kids sparkler circle tightens; he steps heat boundary line chalk faint grass.",
          cliffhangers: [
            "Fire truck distant siren festival permit sign date argument whisper adult cluster.",
            "Cooler ice melt reveals two beverage brands same color can ring confusion.",
            "Portable shade canopy guy line stake foot trip shadow merge dusk.",
          ],
        },
      ]),
      loc("Sneaker consignment back room, shoe boxes stacked to ceiling", [
        {
          description:
            "Authentication UV light on stitching; box label size half digit smudge 9 or 8.",
          cliffhangers: [
            "Second pair same SKU different factory date stamp insole peel corner.",
            "Seller phone shows cash app name mismatch ID last name polite pause.",
            "Security cam red LED reflected shoebox mirror uncertainty who watch who buy.",
          ],
        },
        {
          description:
            "Trade plus cash counter offer written napkin two handwritings incentive unclear who added zero.",
          cliffhangers: [
            "Receipt book duplicate carbon missing page gap thumb through.",
            "Door buzzer second party entering narrow aisle squeeze tray drop risk.",
            "Phone trade app escrow timer sixty seconds thumb release not confirm.",
          ],
        },
      ]),
      loc("Downtown parking garage pay station, yellow paint and echo", [
        {
          description:
            "Lost ticket button screen estimate day rate versus flat lost fee math pause wallet half open.",
          cliffhangers: [
            "Help intercom static voice gender filter unclear repeats amount twice different.",
            "Barrier arm shudders not rising tire on sensor line front axle ambiguous.",
            "Receipt slot jam previous customer slip corner visible partial plate number not his.",
          ],
        },
        {
          description:
            "Monthly pass scanner beep fail windshield sticker sun fade peel edge.",
          cliffhangers: [
            "Security golf cart appears left ramp right ramp mirror trick reflection double.",
            "Phone parking app session expired re-login fingerprint smudge fail once.",
            "Elevator door ding, hold-open buzzer, third car lobby smell of food — unrelated hunger distraction.",
          ],
        },
      ]),
      loc("Apartment rooftop sunset, plastic chairs and planters", [
        {
          description:
            "Roommate proposes split utility overcharge printout two columns informal highlighter both partially faded toner.",
          cliffhangers: [
            "Landlord text joins thread mid argument attachment PDF password hint birthday wrong year.",
            "Grill propane neighbor borrow tank gauge needle stuck midpoint trust flick not done.",
            "Drone hobbyist next roof wave gesture unclear consent fly near privacy line.",
          ],
        },
        {
          description:
            "Date arrives early staircase door glass reflection two bouquets visible wrong hallway floor mismatch.",
          cliffhangers: [
            "Door code keypad new tenant sticker partial peel 5 or 6 digit rumor.",
            "Music speaker Bluetooth paired unknown device name generic phone model list.",
            "Weather app rain cell minute passes balcony dry half city sky split line dramatic.",
          ],
        },
      ]),
    ],
  },

  yuki: {
    scenes: [
      loc("Quiet manga aisle in a bookstore, tall shelves", [
        {
          description:
            "Two final volumes same series different cover art reprint; she lifts one spine then the other without opening either.",
          cliffhangers: [
            "Staff sticker says last copy both slots labeled duplicate spine check.",
            "Reading copy taped inside counter not for sale sign corner curl.",
            "Phone low battery notification overlays release calendar screenshot conflicting date.",
          ],
        },
        {
          description:
            "Someone reaches past her shoulder for a high shelf volume; she steps sideways mid-reach, foot half on carpet strip.",
          cliffhangers: [
            "Dust motes beam slice touches both their sleeves static hair rise.",
            "Basketball practice shoe squeak distant store intercom unrelated code phrase.",
            "Bookmark ribbon slips from her bag hem someone else's genre color peek.",
          ],
        },
      ]),
      loc("Cat café window booth, cushions and low tables", [
        {
          description:
            "A cat stretches on the cushion beside her; the treat jar clicks at the counter, her hand on her bag strap not pocket.",
          cliffhangers: [
            "Second cat blinks from neighboring stool eye level tail still mistimed blink.",
            "Menu board third row drink names blur steam wand hiss incomplete order syllable.",
            "Window reflection overlays passerby silhouette halo rainy umbrella color merge hers.",
          ],
        },
        {
          description:
            "Headphones slide to neck; staff asks for her order while twelve drinks listed, eyes stuck on the third row.",
          cliffhangers: [
            "Cat paw taps her sleeve thread loop loose button risk snag pause.",
            "Loyalty stamp card one empty slot pen offered two colors caps identical barrels.",
            "Phone camera accidental open selfie mode ceiling light ring harsh pupil shrink.",
          ],
        },
      ]),
      loc("Small stationery sticker shelves, afternoon quiet", [
        {
          description:
            "Two washi tapes same width different patterns; she lifts one, sets it down, price sticker corner not peeled.",
          cliffhangers: [
            "Buy-two deal sign arrow ambiguous second item shelf below knee height.",
            "Sample sheet humidity corner lift bubble symmetry break risk thumb hover.",
            "Ambient music lyric word sounds like her name foreign language chorus almost.",
          ],
        },
        {
          description:
            "Sketchbook page stays blank; reference photo on phone dims to lock before a line is drawn.",
          cliffhangers: [
            "Fingerprint smudge unlock fails first try second try moisture nervous.",
            "Eraser crumb heart shape accidental desk dust blow coordinate breath held.",
            "Store clock tick sync off music beat one half second anxiety loop.",
          ],
        },
      ]),
      loc("Campus courtyard bench at dusk, one path lamp", [
        {
          description:
            "Club flyer two booths same night time overlap; she holds both corners, lamppost buzz faint.",
          cliffhangers: [
            "Map QR printed skew lines middle building two entrances unmarked accessible icon.",
            "Friend silhouette wave distance ambiguous which fork path tree shadow split.",
            "Pigeon flock lift wing noise masks footstep behind bench not accounted yet.",
          ],
        },
        {
          description:
            "Someone holds door from inside; she steps aside mid-threshold, both feet in shadow strip.",
          cliffhangers: [
            "Automatic door sensor reopens bounce heel almost clip slow beep.",
            "Umbrella drip line crosses her shoe choice jump or soak millisecond.",
            "ID lanyard swing catches bench bolt heart charm spin glint distract.",
          ],
        },
      ]),
      loc("Convenience store dessert cooler, fogged glass door", [
        {
          description:
            "Bakery tongs touch melon bun then cream puff; steam fogs glass between her breath and pastry.",
          cliffhangers: [
            "Price flip card behind fog digit seven partly ice crystal obscured.",
            "Second customer reflection hand same tong moment polite yield micro bow freeze.",
            "Freezer motor surge light flicker aisle one not two synchronized.",
          ],
        },
        {
          description:
            "Point card one stamp from reward; register asks combine two small items or separate transaction totals differ.",
          cliffhangers: [
            "Receipt printer out of paper sound silence manager key gesture unclear direction.",
            "Gachapon machine near exit rare color visible through plastic envy lock quarter pocket.",
            "Entry bell rings child voice excites same dessert namedifferent flavor seasonal.",
          ],
        },
      ]),
      loc("Quiet laundromat folding corner, warm machines thumping", [
        {
          description:
            "Three dryers buzz; hers is the middle number; detergent pod squishes in her palm, not tossed yet.",
          cliffhangers: [
            "Someone else's sock static-clings her sweater shoulder unnoticed in mirror blind spot.",
            "Folding diagram sign corner peeled step three missing illustration guess.",
            "Exit door window reflects two people with keys not her floor ambiguous wave.",
          ],
        },
        {
          description:
            "Vending drink buttons two identical colors different brands; LED reflection on glass hides label text.",
          cliffhangers: [
            "Coin return slot clink foreign currency size jam polite panic inhale.",
            "Change machine out of order tape curl reveals yesterday date crossed out.",
            "Phone alarm class overlapwash end buzz same vibration pattern double meaning stress.",
          ],
        },
      ]),
      loc("Craft fair handmade table, cloth canopy and jars", [
        {
          description:
            "Two enamel pins same cat pose different glaze; vendor says one-of-a-kind each; she compares backs under shade.",
          cliffhangers: [
            "Sunbeam moves cloud shadow line halfway pin surface glitter variance.",
            "Vendor cousin taps shoulder restock box identical pins bulk contradiction whisper.",
            "Square reader tip screen obscures total momentarily thumb hover cancel invisible.",
          ],
        },
        {
          description:
            "Wind lifts corner price tag handwritten yen symbol crossed out dollar ambiguous conversion mental.",
          cliffhangers: [
            "Canopy guy line stake foot trip mud print size not hers approaching.",
            "Rain patter begin one panel dry rhythm uneven percussion nerve tick.",
            "Crowd applause distant stage obscures vendor question repeat polite lean in.",
          ],
        },
      ]),
      loc("City botanical greenhouse mist, ferns and gravel path", [
        {
          description:
            "Misting cycle starts; she lowers phone camera without snapping, droplets bead on orchid leaves beside path.",
          cliffhangers: [
            "Sign says do not touch petal visitor kid finger millimeter shy rule conflict empathy.",
            "Glass roof shadow bird silhouette two wing beats sync mist nozzle hiss offbeat.",
            "Map kiosk rotate arrow delayed GPS compass app disagree north feather tilt.",
          ],
        },
        {
          description:
            "Butterfly lands her shoulder bag strap; second species flickers peripheral same family pattern uncertainty.",
          cliffhangers: [
            "Guide volunteer offers macro lens loan return time fifteen versus twenty conflicting whisper.",
            "Humidity curls drawing paper corner sketchpad clip loose wind tunnel vent surprise.",
            "Exit arch frame sun flare lens ghost orb photo skepticism rational fear cute.",
          ],
        },
      ]),
    ],
  },
};

export function getClipSuggestionsForSlug(slug: string | null | undefined): CharacterClipSuggestions {
  if (!slug) return EMPTY;
  return CLIP_SUGGESTIONS_BY_SLUG[slug] ?? EMPTY;
}

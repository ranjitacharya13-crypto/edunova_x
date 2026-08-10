"""
EduNova AI — Tutor Engine
=========================
A conversational, Socratic AI tutor that behaves like an experienced teacher
sitting beside the student.

This engine is intentionally rule-based and self-contained (no external LLM /
API key required) so it never depends on a paid model service. It:

  * understands the student's intent and missing information
  * asks ONE useful follow-up question at a time (never dumps a list of
    questions)
  * never asks for information that is already known (from the incoming
    tutoringContext or the message itself)
  * teaches step-by-step (definition -> intuition -> analogy -> explanation ->
    example -> check question)
  * evaluates answers, gives hints, corrects politely, adapts difficulty
  * supports learn / practice / exam prep / revision / doubt modes
  * matches the student's language (English / Tamil / Tanglish detection)
  * reacts empathetically to student emotion
  * uses available student context (name, class, grade)
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Identity / constants
# ---------------------------------------------------------------------------

ASSISTANT_NAME = "EduNova AI"
ASSISTANT_SUBTITLE = "Your personal learning assistant"

GOAL_OPTIONS = [
    {"id": "learn", "label": "\U0001F4DA Learn it"},
    {"id": "practice", "label": "\U0001F4DD Practice"},
    {"id": "exam", "label": "\U0001F3AF Exam prep"},
    {"id": "revision", "label": "\U0001F504 Quick revision"},
]

# Subjects the platform knows about (used for dynamic suggestions).
SUPPORTED_SUBJECTS = [
    "Mathematics",
    "Science",
    "Physics",
    "Chemistry",
    "Biology",
    "English",
    "Computer Science",
    "Social Science",
    "Tamil",
]

# Default first-conversation subject suggestions (Part 4 of the spec).
DEFAULT_SUBJECT_SUGGESTIONS = [
    "Mathematics",
    "Science",
    "English",
    "Computer Science",
    "Social Science",
]

# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------


def _norm(text: str) -> str:
    """Lowercase, strip diacritics/apostrophes, collapse whitespace."""
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.replace("\u2019", "'")
    text = re.sub(r"'", "", text)
    text = re.sub(r"\s*&\s*", " and ", text)
    return re.sub(r"\s+", " ", text).strip().lower()


# ---------------------------------------------------------------------------
# Language adaptation (English / Tamil / Tanglish)
# ---------------------------------------------------------------------------

_TAMIL_CHAR = re.compile(r"[\u0b80-\u0bff]")


def detect_language(text: str) -> str:
    if _TAMIL_CHAR.search(text):
        return "tamil"
    return "english"


# Common emotional cues
_EMOTION_RULES = [
    (re.compile(r"\b(don'?t\s+understand|not?\s+getting|confus|no\s+idea)\b", re.I), "confused"),
    (re.compile(r"\b(this\s+is\s+(too\s+)?difficult|too\s+hard|very\s+tough)\b", re.I), "frustrated"),
    (re.compile(r"\b(got\s+it|understood|now\s+i\s+know|gotcha|i\s+get\s+it|make\s+sense|makes\s+sense)\b", re.I), "succeeded"),
    (re.compile(r"\b(easy|simple|straightforward)\b", re.I), "confident"),
    (re.compile(r"\b(stuck|help|can'?t\s+solve|not\s+able)\b", re.I), "stuck"),
]

_EMOTION_REPLY = {
    "confused": (
        "No problem. Let's slow it down and start from the simplest idea. "
        "I'll go one small step at a time."
    ),
    "frustrated": "That's okay. We'll break it into smaller pieces so it doesn't feel overwhelming.",
    "stuck": "No worries — being stuck is part of learning. Let's work through it together, one small step.",
    "succeeded": "Excellent. Let's test that understanding with one quick question.",
    "confident": "Love the confidence. Let's make sure you've really got it with a quick check.",
}


def detect_emotion(message: str) -> Optional[str]:
    for pattern, label in _EMOTION_RULES:
        if pattern.search(message):
            return label
    return None


# ---------------------------------------------------------------------------
# Subject / topic / goal discovery
# ---------------------------------------------------------------------------

_SUBJECT_KEYWORDS = {
    "mathematics": ["math", "maths", "mathematics", "algebra", "geometry", "trigonometry", "calculus", "arithmetic", "statistics", "probability", "linear equations", "quadratic", "pythagoras", "coordinate"],
    "science": ["science", "natural science", "general science"],
    "physics": ["physics", "newton", "motion", "force", "light", "electricity", "energy", "momentum", "gravitation", "sound", "heat", "optics", "mechanics"],
    "chemistry": ["chemistry", "atom", "molecule", "chemical", "acid", "base", "periodic table", "reaction", "valence"],
    "biology": ["biology", "photosynthesis", "cell", "dna", "respiration", "human body", "digestion", "organism", "evolution"],
    "english": ["english", "grammar", "tense", "vocabulary", "comprehension", "essay", "preposition", "sentence"],
    "computer science": ["computer", "computer science", "programming", "coding", "algorithm", "python", "java", "data structure", "binary search", "sorting", "javascript", "html", "css", "database", "ai", "machine learning"],
    "social science": ["social", "history", "geography", "civics", "economics", "politics", "indian history", "world war"],
    "tamil": ["tamil", "\u0ba4\u0bae\u0bbf\u0bb4\u0bcd"],
}

_TOPIC_BY_SUBJECT = {
    "mathematics": ["Algebra", "Geometry", "Trigonometry", "Statistics", "Arithmetic", "Probability"],
    "science": ["Physics", "Chemistry", "Biology"],
    "physics": ["Motion", "Newton's Laws", "Work & Energy", "Electricity", "Light", "Gravitation"],
    "chemistry": ["Atoms & Molecules", "Acids & Bases", "Chemical Reactions", "Periodic Table"],
    "biology": ["Photosynthesis", "Cells", "Human Body", "Respiration", "DNA"],
    "english": ["Grammar", "Tenses", "Comprehension", "Vocabulary"],
    "computer science": ["Binary Search", "Variables", "Loops", "Functions", "Sorting", "Data Structures"],
    "social science": ["Indian History", "Geography", "Civics", "Economics"],
    "tamil": ["\u0b87\u0bb2\u0b95\u0bcd\u0b95\u0ba3\u0bae\u0bcd", "Kavithai", "\u0b87\u0baf\u0bb2\u0bcd"],
}

_GOAL_KEYWORDS = {
    "exam": ["exam", "test", "preparation", "prepare", "prep", "board exam", "grade"],
    "practice": ["practice", "exercise", "questions", "problems", "worksheet", "test me"],
    "revision": ["revision", "revise", "review", "recap", "quick summary", "summary"],
    "learn": ["learn", "teach", "understand", "explain", "study", "concept", "topic"],
    "doubt": ["doubt", "question", "doubt solving", "clarify", "confused about", "what is", "why", "how"],
}


def _title_subject(canonical: str) -> str:
    return "Computer Science" if canonical == "computer science" else canonical.title()


def find_subject(message: str, known: Optional[str] = None):
    """Return the canonical subject found in the message; otherwise fall back to
    the known subject. The message takes priority so a student switching from
    Science to Physics is honoured."""
    norm = _norm(message)
    # Message first.
    if norm:
        for canonical, keywords in _SUBJECT_KEYWORDS.items():
            for kw in keywords:
                # Match as the start of a word so plurals/derivatives work
                # (e.g. "newton" -> "newtons laws", "math" -> "mathematics").
                if re.search(r"(?<![a-z])" + re.escape(kw), norm):
                    return _title_subject(canonical)
        if "science" in norm:
            return "Science"
    # Fall back to known context. Known is normally a display name
    # (e.g. "Computer Science"); prefer an exact display match so the broad
    # "science" canonical is not matched by a substring inside "computer science".
    if known:
        k = _norm(known)
        for canonical in _SUBJECT_KEYWORDS:
            if k == _norm(_title_subject(canonical)):
                return _title_subject(canonical)
        best = None
        for canonical in _SUBJECT_KEYWORDS:
            c = _norm(canonical)
            if c in k and (best is None or len(c) > len(_norm(best))):
                best = canonical
        if best:
            return _title_subject(best)
    return None


def find_goal(message: str, known: Optional[str] = None):
    norm = _norm(message)
    # Message first so the student can switch modes (e.g. learn -> practice).
    for goal, keywords in _GOAL_KEYWORDS.items():
        for kw in keywords:
            if re.search(r"\b" + re.escape(kw) + r"\b", norm):
                return goal
    return known if known else None


def find_topic(message: str):
    """Try to find a topic mentioned in the message (best-effort)."""
    norm = _norm(message)
    # If the whole message is literally a subject name (e.g. "Physics",
    # "Science"), it is a subject selection, NOT a topic — don't match it as a
    # topic. Single-word topics like "Algebra" / "Motion" are NOT subject names
    # and must still be matched.
    subject_names = {_norm(s) for s in SUPPORTED_SUBJECTS}
    if len(norm.split()) == 1 and norm in subject_names:
        return None
    # strip leading "i am studying / the topic is / chapter" etc
    for phrase in ["the topic is", "topic is", "chapter is", "i am studying", "i'm studying", "we are doing", "working on"]:
        idx = norm.find(phrase)
        if idx != -1:
            after = norm[idx + len(phrase):].strip(" \n\t:.")
            if after:
                return after.title()
    # Known topic keywords (skip topic names that are also subject names, e.g.
    # "Physics" listed under Science's topic suggestions).
    all_topics = set()
    for topics in _TOPIC_BY_SUBJECT.values():
        for topic in topics:
            all_topics.add(_norm(topic))
    for topic in all_topics:
        if topic in subject_names:
            continue
        if re.search(r"(?<![a-z])" + re.escape(topic), norm):
            return topic.title()
    return None


# ---------------------------------------------------------------------------
# Knowledge base of lessons
# ---------------------------------------------------------------------------
# Each lesson: definition, intuition, analogy, explanation (steps), example,
# question, answer (keywords), hint, revise (bullets), mistakes, trick, advanced.

_KB = {
    ("mathematics", "algebra"): {
        "definition": "Algebra is the branch of mathematics that uses letters (like x and y) to represent unknown numbers, so we can solve problems with equations.",
        "intuition": "Think of a balance scale: whatever you do to one side, you must do to the other to keep it balanced.",
        "analogy": "An equation is like a mystery: 'something plus 3 equals 10' — algebra is the tool that finds the hidden 'something'.",
        "explanation": [
            "A variable (like x) is a placeholder for an unknown value.",
            "An equation states that two expressions are equal, e.g. 2x + 3 = 11.",
            "To solve, isolate the variable on one side using inverse operations.",
            "Subtract 3 from both sides: 2x = 8.",
            "Divide both sides by 2: x = 4.",
            "Always check your answer in the original equation.",
        ],
        "example": "Solve 2x + 3 = 11. Subtract 3 from both sides → 2x = 8. Divide by 2 → x = 4. Check: 2(4)+3 = 11 ✓",
        "question": "If 3x − 5 = 16, what is the value of x?",
        "answer": ["7", "x=7", "x = 7"],
        "hint": "Add 5 to both sides first to isolate the 3x, then divide by 3.",
        "revise": ["Letters stand for unknown numbers.", "Keep the equation balanced.", "Inverse operations undo each other.", "Always check your answer."],
        "mistakes": ["Forgetting to apply the operation to BOTH sides.", "Adding instead of using the inverse operation.", "Not checking the final answer."],
        "trick": "Remember: whatever you do to one side, do to the other — 'same on both sides'.",
        "advanced": "Later you'll meet quadratic equations (ax²+bx+c=0) solved by factoring, completing the square, or the quadratic formula.",
    },
    ("mathematics", "trigonometry"): {
        "definition": "Trigonometry studies relationships between the angles and sides of triangles, especially right-angled triangles.",
        "intuition": "The ratio of a triangle's sides stays constant for a fixed angle, no matter how big the triangle is.",
        "analogy": "A ladder leaning against a wall makes a right triangle; trigonometry tells you the height it reaches if you know the angle.",
        "explanation": [
            "In a right triangle label the sides: opposite, adjacent, hypotenuse.",
            "Sine (sin) = opposite / hypotenuse.",
            "Cosine (cos) = adjacent / hypotenuse.",
            "Tangent (tan) = opposite / adjacent.",
            "Use SOH-CAH-TOA to remember which ratio uses which sides.",
            "Pick the ratio that contains the two sides you know and the one you need.",
        ],
        "example": "For angle 30°, sin30° = 1/2. If the hypotenuse is 10 and you need the opposite side: opposite = 10 × sin30° = 5.",
        "question": "In a right triangle, if sinθ = opposite/hypotenuse and opposite=3, hypotenuse=5, what is sinθ?",
        "answer": ["0.6", "3/5", "3 / 5"],
        "hint": "Just divide the opposite side by the hypotenuse: 3 ÷ 5.",
        "revise": ["SOH-CAH-TOA: sin=O/H, cos=A/H, tan=O/A.", "Ratios depend only on the angle.", "Hypotenuse is the longest side.", "Angles often measured in degrees."],
        "mistakes": ["Using the wrong ratio for the sides given.", "Confusing adjacent with opposite.", "Forgetting the angle mode (degrees vs radians)."],
        "trick": "SOH-CAH-TOA — a friendly mnemonic for the three ratios.",
        "advanced": "Trigonometry extends to the unit circle and is the foundation of calculus, physics, and engineering waves.",
    },
    ("mathematics", "geometry"): {
        "definition": "Geometry studies shapes, sizes, positions, and the properties of space.",
        "intuition": "Every shape can be described by angles, sides, and area — geometry connects those ideas.",
        "analogy": "Shapes are like building blocks; geometry tells us how they fit together and how much space they take.",
        "explanation": [
            "A point, line, and plane are the basic building blocks.",
            "Triangles are rigid and add up to 180°.",
            "Area of a rectangle = length × width.",
            "Area of a triangle = ½ × base × height.",
            "The Pythagorean theorem: a² + b² = c² for right triangles.",
            "Perimeter is the distance around a shape.",
        ],
        "example": "A rectangle is 5 cm by 3 cm. Area = 5 × 3 = 15 cm². Perimeter = 2×(5+3) = 16 cm.",
        "question": "A right triangle has legs of 3 and 4. What is the length of the hypotenuse?",
        "answer": ["5", "5 units", "5cm"],
        "hint": "Use a² + b² = c²: 3² + 4² = 9 + 16 = 25, then take the square root.",
        "revise": ["Angles in a triangle sum to 180°.", "Area rectangle = l×w.", "Pythagoras: a²+b²=c².", "Perimeter = sum of all sides."],
        "mistakes": ["Mixing up area and perimeter units.", "Forgetting to halve for triangle area.", "Adding sides that shouldn't be added."],
        "trick": "3-4-5 is a famous right triangle: 9 + 16 = 25, c = 5.",
        "advanced": "Beyond 2D, geometry moves to 3D volumes and into coordinate geometry on a plane.",
    },
    ("mathematics", "statistics"): {
        "definition": "Statistics is the study of collecting, analysing, and drawing conclusions from data.",
        "intuition": "Statistics turns a messy list of numbers into a few meaningful summaries.",
        "analogy": "Averages are like the 'typical value' of a group — the centre around which the data clusters.",
        "explanation": [
            "Mean = sum of all values ÷ number of values.",
            "Median = the middle value when data is ordered.",
            "Mode = the most frequent value.",
            "Range = largest − smallest.",
            "Mean is affected by outliers; median is more robust.",
            "Graphs (bar, pie, histogram) visualise the data.",
        ],
        "example": "For data 2, 3, 5, 5, 10: mean=(2+3+5+5+10)/5=5, median=5, mode=5.",
        "question": "For the numbers 4, 7, 7, 9 — what is the mode?",
        "answer": ["7", "7 is the mode", "mode is 7"],
        "hint": "The mode is the number that appears most often.",
        "revise": ["Mean = average.", "Median = middle (order first!).", "Mode = most frequent.", "Range = max − min."],
        "mistakes": ["Forgetting to order data before finding the median.", "Confusing median with mean.", "Forgetting to divide when finding the mean."],
        "trick": "Mean is the one you calculate; median is the one in the middle; mode starts with 'mo' — most often.",
        "advanced": "Statistics grows into probability distributions, standard deviation, and inferential statistics.",
    },
    ("mathematics", "arithmetic"): {
        "definition": "Arithmetic is the basic mathematics of numbers: addition, subtraction, multiplication, and division.",
        "intuition": "These four operations are the building blocks of all of mathematics.",
        "analogy": "Think of arithmetic as the basic tools in a toolkit — every harder problem uses them.",
        "explanation": [
            "Addition (+) combines quantities.",
            "Subtraction (−) finds the difference.",
            "Multiplication (×) is repeated addition.",
            "Division (÷) is splitting into equal groups.",
            "Order of operations: BODMAS / PEMDAS.",
            "Brackets first, then Orders (powers), then Division/Multiplication, then Addition/Subtraction.",
        ],
        "example": "Evaluate 3 + 4 × 2 = 3 + 8 = 11 (multiply before adding, do NOT go left to right).",
        "question": "What is the value of (2 + 3) × 4?",
        "answer": ["20", "2+3=5, 5x4=20"],
        "hint": "Handle the brackets first: 2 + 3 = 5, then multiply by 4.",
        "revise": ["BODMAS/PEMDAS order.", "Multiplication before addition.", "Brackets first.", "Division is sharing equally."],
        "mistakes": ["Going left to right instead of following BODMAS.", "Forgetting negative sign rules.", "Mixing up dividend and divisor."],
        "trick": "BODMAS: Brackets, Orders, Division, Multiplication, Addition, Subtraction.",
        "advanced": "Arithmetic extends into fractions, decimals, percentages, and negative numbers.",
    },
    ("mathematics", "probability"): {
        "definition": "Probability measures how likely an event is to happen, as a number from 0 to 1.",
        "intuition": "Probability is the chance of something, like the odds of a coin landing heads.",
        "analogy": "A probability of 0 means 'never', 1 means 'always', and 0.5 means 'half the time'.",
        "explanation": [
            "Probability = (favourable outcomes) ÷ (total possible outcomes).",
            "Values range from 0 (impossible) to 1 (certain).",
            "Complement rule: P(not A) = 1 − P(A).",
            "For two independent events, multiply their probabilities.",
            "A coin has 2 outcomes; a fair die has 6.",
        ],
        "example": "Flipping a fair coin: P(heads) = 1/2. Rolling a 3 on a die: P = 1/6.",
        "question": "What is the probability of rolling an even number on a standard 6-sided die?",
        "answer": ["1/2", "0.5", "3/6", "1 / 2"],
        "hint": "Even numbers on a die are 2, 4, 6 → 3 favourable out of 6 total.",
        "revise": ["P = favourable / total.", "Range 0 to 1.", "P(not A) = 1 − P(A).", "Independent events multiply."],
        "mistakes": ["Writing probabilities above 1.", "Forgetting to count all outcomes.", "Adding instead of multiplying for independent events."],
        "trick": "'Can't happen' = 0, 'always' = 1.",
        "advanced": "Probability leads to combinations, permutations, and the basis of statistics and machine learning.",
    },
    ("physics", "newton's laws"): {
        "definition": "Newton's laws of motion describe how forces change the motion of objects.",
        "intuition": "Objects keep doing what they're doing unless something pushes or pulls them.",
        "analogy": "A football on the ground stays still until you kick it — that's inertia (First Law).",
        "explanation": [
            "First Law (inertia): an object stays at rest or in uniform motion unless a net force acts on it.",
            "Second Law: Force = mass × acceleration (F = ma).",
            "Third Law: for every action there's an equal and opposite reaction.",
            "Mass is how much matter; weight is the force due to gravity.",
            "Friction and air resistance are common forces that slow things.",
        ],
        "example": "Push a 2 kg cart to accelerate it at 3 m/s²: F = 2 × 3 = 6 N.",
        "question": "If you push a 5 kg box and it accelerates at 2 m/s², what force do you apply?",
        "answer": ["10", "10 n", "10 newtons", "10n"],
        "hint": "Use F = ma. Multiply the mass by the acceleration: 5 × 2.",
        "revise": ["F = ma.", "Inertia keeps things moving.", "Action–reaction pairs.", "Weight = mg."],
        "mistakes": ["Confusing mass and weight.", "Forgetting that forces are vectors (direction matters).", "Thinking equal-and-opposite forces cancel the same object."],
        "trick": "F = ma — 'Forces Make Acceleration'.",
        "advanced": "Newton's laws combine into momentum (p = mv) and energy conservation, the heart of mechanics.",
    },
    ("physics", "motion"): {
        "definition": "Motion is the change of an object's position over time, described by distance, speed, velocity, and acceleration.",
        "intuition": "Speed tells you how fast; velocity adds direction; acceleration tells how fast the speed changes.",
        "analogy": "A car's speedometer shows speed; the accelerator pedal creates acceleration.",
        "explanation": [
            "Speed = distance ÷ time.",
            "Velocity = displacement ÷ time (includes direction).",
            "Acceleration = change in velocity ÷ time.",
            "Uniform motion keeps constant speed.",
            "Equations of motion connect u, v, a, t, s.",
            "v = u + at and s = ut + ½at² are key formulas.",
        ],
        "example": "A car goes 100 m in 20 s. Speed = 100/20 = 5 m/s.",
        "question": "If a runner covers 200 metres in 40 seconds, what is their average speed in m/s?",
        "answer": ["5", "5 m/s", "5m/s"],
        "hint": "Divide the distance by the time: 200 ÷ 40.",
        "revise": ["Speed = d/t.", "Velocity has direction.", "Acceleration = Δv/t.", "m/s is the SI unit of speed."],
        "mistakes": ["Confusing speed and velocity.", "Mixing up units (km/h vs m/s).", "Forgetting acceleration can be negative (deceleration)."],
        "trick": "Speed = d/t: 'distance over time'.",
        "advanced": "Motion generalises to graphs (distance-time, velocity-time) and into Newton's laws.",
    },
    ("physics", "electricity"): {
        "definition": "Electricity is the flow of electric charge through a circuit, driven by voltage and opposed by resistance.",
        "intuition": "Voltage pushes charge; current is how much flows; resistance slows it down.",
        "analogy": "Water in a pipe: voltage is the water pressure, current is the flow rate, resistance is the pipe's narrowness.",
        "explanation": [
            "Voltage (V) is the 'push' — measured in volts.",
            "Current (I) is the flow of charge — measured in amperes.",
            "Resistance (R) opposes the flow — measured in ohms.",
            "Ohm's law: V = I × R.",
            "Power: P = V × I.",
            "Circuits can be series or parallel.",
        ],
        "example": "A 6 V battery drives 2 A through a bulb. R = V/I = 6/2 = 3 Ω.",
        "question": "If a circuit has a 12 V source and a current of 3 A, what is the resistance?",
        "answer": ["4", "4 ohm", "4 ohms", "4\u03a9"],
        "hint": "Use R = V ÷ I: 12 ÷ 3.",
        "revise": ["V = IR (Ohm's law).", "P = VI.", "Series adds resistance.", "Voltage in volts, current in amps."],
        "mistakes": ["Using the wrong rearranged form of V=IR.", "Mixing up series and parallel rules.", "Ignoring units."],
        "trick": "V = IR — 'Volts = I Resist' (I is current).",
        "advanced": "Electricity extends into AC/DC, circuits with capacitors, and power systems.",
    },
    ("physics", "light"): {
        "definition": "Light is a form of energy that travels as waves, enabling sight and reflection/refraction phenomena.",
        "intuition": "Light travels in straight lines until it bounces off or bends through a surface.",
        "analogy": "Light behaves like ripples on water — waves that carry energy.",
        "explanation": [
            "Light travels in straight lines (rectilinear propagation).",
            "Reflection: light bounces off surfaces; angle of incidence = angle of reflection.",
            "Refraction: light bends when it changes medium (speed changes).",
            "Lenses and prisms use refraction to focus or spread light.",
            "Speed of light ≈ 3 × 10⁸ m/s in vacuum.",
            "The spectrum: white light splits into colours.",
        ],
        "example": "A mirror reflects your image because light bounces back at the same angle it hits.",
        "question": "The angle of incidence is 40°. What is the angle of reflection?",
        "answer": ["40", "40 degrees", "40\u00b0"],
        "hint": "Reflection rule: angle of incidence equals angle of reflection.",
        "revise": ["Light travels straight.", "i = r (reflection).", "Refraction bends light.", "c ≈ 3×10⁸ m/s."],
        "mistakes": ["Confusing reflection and refraction.", "Forgetting the angle is measured from the normal.", "Thinking light slows to zero in a medium."],
        "trick": "Reflection = 'bounce back'; Refraction = 'bend' — both start with 'ref'.",
        "advanced": "Light also behaves as particles (photons), the basis of quantum physics and lasers.",
    },
    ("chemistry", "atoms & molecules"): {
        "definition": "Atoms are the smallest units of matter; molecules are groups of atoms bonded together.",
        "intuition": "Everything around you is made of tiny building blocks called atoms.",
        "analogy": "Atoms are like LEGO bricks — combine different ones in different ways to build everything.",
        "explanation": [
            "An atom has protons and neutrons in the nucleus and electrons around it.",
            "The atomic number = number of protons.",
            "Protons are positive, electrons negative, neutrons neutral.",
            "Atoms bond to form molecules (e.g. H₂O has 2 H + 1 O).",
            "The periodic table organises elements by atomic number.",
            "Valence electrons determine how atoms bond.",
        ],
        "example": "Water is H₂O: two hydrogen atoms bonded to one oxygen atom.",
        "question": "What is the atomic number of an atom that has 6 protons?",
        "answer": ["6", "6 is the atomic number"],
        "hint": "The atomic number is just the number of protons.",
        "revise": ["Atom = protons + neutrons + electrons.", "Atomic number = protons.", "Molecule = atoms bonded together.", "Elements organised in periodic table."],
        "mistakes": ["Confusing atomic number with mass number.", "Thinking atoms are the smallest possible (quarks exist).", "Forgetting electrons orbit the nucleus."],
        "trick": "Atomic number = protons — same count, both start with 'a' and 'p'.",
        "advanced": "Bonding types: ionic (electron transfer) and covalent (electron sharing) drive all chemistry.",
    },
    ("chemistry", "acids & bases"): {
        "definition": "Acids and bases are substances that either release H⁺ (acids) or OH⁻/accept H⁺ (bases) in solution.",
        "intuition": "Acids taste sour and turn blue litmus red; bases feel slippery and turn red litmus blue.",
        "analogy": "Think of a tug-of-war for hydrogen ions — acids donate them, bases accept them.",
        "explanation": [
            "Acids release hydrogen ions (H⁺) in water.",
            "Bases release hydroxide ions (OH⁻) or accept H⁺.",
            "pH scale runs 0–14: below 7 acidic, 7 neutral, above 7 basic.",
            "Acid + base → salt + water (neutralisation).",
            "Strong acids (HCl) fully dissociate; weak acids partially.",
        ],
        "example": "Lemon juice is acidic (pH ~2); soap is basic (pH ~9).",
        "question": "A solution has pH 3. Is it acidic, basic, or neutral?",
        "answer": ["acidic", "acid", "acidic solution"],
        "hint": "pH below 7 means acidic.",
        "revise": ["Acids give H⁺.", "Bases give OH⁻/accept H⁺.", "pH < 7 = acid.", "Neutralisation → salt + water."],
        "mistakes": ["Thinking high pH is acidic.", "Confusing pH with strength.", "Forgetting neutralisation produces water."],
        "trick": "pH is a 'power of Hydrogen' — lower pH = more H⁺ = more acid.",
        "advanced": "Strong vs weak vs concentrated vs dilute are four different ideas that students often mix up.",
    },
    ("biology", "photosynthesis"): {
        "definition": "Photosynthesis is the process by which plants make their own food (glucose) using sunlight, water, and carbon dioxide.",
        "intuition": "Plants are like tiny solar-powered food factories.",
        "analogy": "A solar panel turns sunlight into electricity; a leaf turns sunlight into food.",
        "explanation": [
            "Chlorophyll in leaves captures sunlight.",
            "Inputs: carbon dioxide + water + sunlight.",
            "Outputs: glucose + oxygen.",
            "6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂.",
            "It happens mainly in the leaves (chloroplasts).",
            "Glucose stores energy for the plant's growth.",
        ],
        "example": "A plant in sunlight takes CO₂ from the air and water from the roots to make glucose and release oxygen.",
        "question": "What gas do plants release during photosynthesis?",
        "answer": ["oxygen", "o2", "oxygen gas"],
        "hint": "It's the gas we breathe in — produced by plants.",
        "revise": ["Inputs: CO₂ + water + sunlight.", "Outputs: glucose + O₂.", "Happens in chloroplasts.", "Pigment: chlorophyll."],
        "mistakes": ["Saying plants 'breathe in' CO₂ like we do (respiration is separate).", "Forgetting water as an input.", "Writing the formula wrong."],
        "trick": "Plants 'photo' = light, 'synthesis' = making — making food using light.",
        "advanced": "Photosynthesis also relates to respiration, the carbon cycle, and food chains.",
    },
    ("biology", "cells"): {
        "definition": "The cell is the basic structural and functional unit of all living organisms.",
        "intuition": "Every living thing is built from cells — like bricks that make a building.",
        "analogy": "A cell is like a tiny city with a nucleus (mayor), mitochondria (power plant), and a membrane (border).",
        "explanation": [
            "Cell membrane controls what enters and leaves.",
            "Nucleus holds DNA and controls activities.",
            "Mitochondria produce energy (cellular respiration).",
            "Plant cells have chloroplasts and a cell wall; animal cells don't.",
            "Cytoplasm is the jelly-like fluid inside.",
            "Organisms can be unicellular or multicellular.",
        ],
        "example": "A red blood cell carries oxygen; a muscle cell contracts to move you.",
        "question": "Which organelle is known as the powerhouse of the cell?",
        "answer": ["mitochondria", "mitochondrion"],
        "hint": "It produces the cell's energy.",
        "revise": ["Membrane = border.", "Nucleus = control centre (DNA).", "Mitochondria = energy.", "Chloroplasts only in plant cells."],
        "mistakes": ["Saying plant cells have no mitochondria.", "Confusing nucleus with nucleolus function.", "Thinking all cells are the same."],
        "trick": "Mitochondria = 'powerhouse' — think 'mito' like 'mighty'.",
        "advanced": "Cells specialise into tissues, organs, and organ systems in multicellular organisms.",
    },
    ("computer science", "binary search"): {
        "definition": "Binary search is an efficient algorithm to find an item in a sorted list by repeatedly halving the search range.",
        "intuition": "Instead of checking every element, you eliminate half the list with each step.",
        "analogy": "Looking up a word in a dictionary: you open to the middle and decide whether the word is before or after, then repeat.",
        "explanation": [
            "Works only on a sorted list.",
            "Find the middle element.",
            "Compare it with the target.",
            "If equal, you found it.",
            "If the target is smaller, search the left half.",
            "If larger, search the right half.",
            "Repeat until found or the range is empty.",
        ],
        "example": "Finding 23 in [2,5,8,12,23,37,45]: middle=12, 23>12 → search right half [23,37,45]; middle=37, 23<37 → [23]; found!",
        "question": "What is the time complexity of binary search?",
        "answer": ["o(log n)", "log n", "o(logn)", "logarithmic", "logn"],
        "hint": "Each step halves the search space, so the number of steps is the log of n.",
        "revise": ["Requires sorted data.", "Halves the range each step.", "O(log n) time.", "O(1) extra space."],
        "mistakes": ["Using it on unsorted data.", "Off-by-one errors on the mid index.", "Infinite loops when low/high don't update."],
        "trick": "Binary = two → always split into two halves.",
        "advanced": "Variants find first/last occurrence; it's the basis of balanced search trees.",
    },
    ("computer science", "variables"): {
        "definition": "A variable is a named container that stores a value which can change during program execution.",
        "intuition": "Variables are like labelled boxes that hold data.",
        "analogy": "A storage locker labelled 'score' that can hold different numbers at different times.",
        "explanation": [
            "Variables have a name, a type, and a value.",
            "Common types: integer, float, string, boolean.",
            "Assignment: score = 10 stores 10 into score.",
            "You can read and update the value later.",
            "Names should be descriptive (e.g. 'totalMarks').",
            "Python: x = 5 creates a variable automatically.",
        ],
        "example": "score = 10; score = score + 5 → now score holds 15.",
        "question": "What data type is the value 'Hello' (in quotes) in most languages?",
        "answer": ["string", "text", "str"],
        "hint": "Values wrapped in quotes are usually text.",
        "revise": ["Variables store data.", "Types: int, float, string, bool.", "Assignment uses '='.", "Names should be descriptive."],
        "mistakes": ["Using the variable before assigning it.", "Confusing assignment (=) with equality (==).", "Spaces/special chars in names."],
        "trick": "Variable = box with a name; = puts something inside.",
        "advanced": "Variables get scoped (local vs global) and can reference mutable/immutable objects.",
    },
    ("computer science", "loops"): {
        "definition": "A loop repeats a block of code a set number of times or until a condition is met.",
        "intuition": "Loops automate repetition so you don't write the same line many times.",
        "analogy": "A washing machine runs the same spin cycle repeatedly — that's a loop.",
        "explanation": [
            "'for' loops iterate over a sequence or a fixed count.",
            "'while' loops repeat while a condition is true.",
            "Each pass is called an iteration.",
            "A loop counter tracks how many times it ran.",
            "Infinite loops happen when the condition never becomes false.",
            "Loop body runs every iteration.",
        ],
        "example": "In Python: for i in range(3): print('Hi') → prints Hi three times.",
        "question": "Which loop runs at least once even if the condition is false? (In many languages) do-while loop — is it true or false?",
        "answer": ["true", "do-while runs once"],
        "hint": "'do-while' executes the body first, then checks the condition.",
        "revise": ["for: known count.", "while: condition-based.", "Each run = iteration.", "Avoid infinite loops."],
        "mistakes": ["Forgetting to update the loop counter.", "Off-by-one in range.", "Infinite loop from a never-false condition."],
        "trick": "For = 'a fixed number of times'; While = 'as long as'.",
        "advanced": "Loops combine with break/continue to control flow precisely.",
    },
    ("computer science", "functions"): {
        "definition": "A function is a reusable block of code that performs a specific task, taking inputs and returning an output.",
        "intuition": "Functions package logic into named building blocks you can call anywhere.",
        "analogy": "A vending machine: you give it input (money + selection) and it returns output (a snack).",
        "explanation": [
            "Define a function once, call it many times.",
            "Parameters are the inputs; return value is the output.",
            "Functions reduce duplication and improve clarity.",
            "They can be tested and reused independently.",
            "In Python: def add(a, b): return a + b.",
            "Call it: result = add(2, 3).",
        ],
        "example": "def add(a, b): return a + b; print(add(2,3)) → prints 5.",
        "question": "What keyword starts a function definition in Python?",
        "answer": ["def", "the def keyword"],
        "hint": "It's a three-letter word, short for 'define'.",
        "revise": ["Functions = reusable blocks.", "Inputs = parameters.", "Output = return value.", "Call by name + parentheses."],
        "mistakes": ["Forgetting the return statement.", "Using undefined variables.", "Modifying global state accidentally."],
        "trick": "Function = 'define once, call many times'.",
        "advanced": "Functions support recursion, default arguments, and higher-order usage (passing functions as values).",
    },
    ("english", "grammar"): {
        "definition": "Grammar is the set of rules that govern how words are arranged to form meaningful sentences.",
        "intuition": "Grammar is the framework that makes communication clear and consistent.",
        "analogy": "Grammar is like the road rules of language — they keep communication flowing smoothly.",
        "explanation": [
            "A sentence has a subject (who/what) and a predicate (what about it).",
            "Nouns name things; verbs show action or state.",
            "Adjectives describe nouns; adverbs describe verbs.",
            "Punctuation (.,!?) clarifies meaning.",
            "Subject-verb agreement: 'He runs' not 'He run'.",
            "Consistent tense keeps a narrative clear.",
        ],
        "example": "In 'The cat sleeps', 'The cat' is the subject and 'sleeps' is the predicate.",
        "question": "In 'She runs fast', which word is the verb?",
        "answer": ["runs"],
        "hint": "The verb is the action word.",
        "revise": ["Subject + predicate.", "Nouns, verbs, adjectives, adverbs.", "Subject-verb agreement.", "Punctuation matters."],
        "mistakes": ["Agreement errors ('She run').", "Run-on sentences.", "Confusing its/it's."],
        "trick": "Verb = the doing word.",
        "advanced": "Advanced grammar covers clauses, mood, voice (active/passive), and conditionals.",
    },
    ("english", "tenses"): {
        "definition": "Tense shows the time of an action: past, present, or future.",
        "intuition": "Tense tells your reader when something happens.",
        "analogy": "Tense is the clock of a sentence — it points to past, now, or future.",
        "explanation": [
            "Present: 'I eat' (routine) or 'I am eating' (right now).",
            "Past: 'I ate' (completed).",
            "Future: 'I will eat'.",
            "Each has simple, continuous, and perfect forms.",
            "Present perfect: 'I have eaten' connects past to now.",
            "Choose tense that matches the time you mean.",
        ],
        "example": "'She walks' (present), 'She walked' (past), 'She will walk' (future).",
        "question": "Which tense is 'I will study tomorrow'?",
        "answer": ["future", "future tense", "will + verb = future"],
        "hint": "'will' signals future time.",
        "revise": ["Past, present, future.", "Continuous = ongoing (-ing).", "Perfect = completed (have/had + -ed).", "'will' = future."],
        "mistakes": ["Shifting tense mid-story.", "Using 'will' for present.", "Wrong irregular past forms ('goed' vs 'went')."],
        "trick": "Listen for time words: yesterday=past, now=present, tomorrow=future.",
        "advanced": "Sequence of tenses in complex sentences and reported speech.",
    },
    ("social science", "indian history"): {
        "definition": "Indian history is the story of the Indian subcontinent from ancient civilisations to modern independence.",
        "intuition": "History is a chain of causes and effects connecting the past to today.",
        "analogy": "History is like reading a long book backwards — each chapter explains the next.",
        "explanation": [
            "Ancient India: Indus Valley civilisation (Harappa, Mohenjo-daro).",
            "Vedic period and early empires (Maurya, Gupta).",
            "Medieval period: Delhi Sultanate, Mughal Empire.",
            "Colonial era: British East India Company, 1857 Revolt.",
            "Freedom struggle: Gandhi, non-cooperation, Quit India.",
            "Independence: 1947.",
        ],
        "example": "The Indus Valley civilisation had planned cities with drainage systems over 4,000 years ago.",
        "question": "In which year did India gain independence?",
        "answer": ["1947"],
        "hint": "It's the year right after the end of WWII.",
        "revise": ["Indus Valley = ancient cities.", "Gupta = golden age.", "Mughals = medieval.", "Independence 1947."],
        "mistakes": ["Confusing chronological order of empires.", "Mixing dates.", "Thinking history is only dates (it's also causes/effects)."],
        "trick": "Remember a timeline: Ancient → Medieval → Colonial → Modern.",
        "advanced": "History connects to geography (trade routes) and economics (colonisation).",
    },
    ("tamil", "\u0b87\u0bb2\u0b95\u0bcd\u0b95\u0ba3\u0bae\u0bcd"): {
        "definition": "\u0b87\u0bb2\u0b95\u0bcd\u0b95\u0ba3\u0bae\u0bcd \u0b8e\u0ba9\u0bcd\u0baa\u0ba4\u0bc1 \u0bae\u0bca\u0bb4\u0bbf\u0baf\u0bbf\u0ba9\u0bcd \u0b9a\u0bb0\u0bbf\u0baf\u0bbe\u0ba9 \u0baa\u0baf\u0ba9\u0bcd\u0baa\u0bbe\u0b9f\u0bcd\u0b9f\u0bc1\u0b95\u0bcd\u0b95\u0bbe\u0ba9 \u0bb5\u0bbf\u0ba4\u0bbf\u0b95\u0bb3\u0bc8 \u0b95\u0bb1\u0bcd\u0baa\u0bbf\u0b95\u0bcd\u0b95\u0bc1\u0bae\u0bcd \u0b95\u0bb2\u0bc8.",
        "intuition": "\u0bae\u0bca\u0bb4\u0bbf \u0b9a\u0bb0\u0bbf\u0baf\u0bbe\u0b95 \u0b85\u0bae\u0bc8\u0baf \u0b87\u0bb2\u0b95\u0bcd\u0b95\u0ba3\u0bae\u0bcd \u0b89\u0ba4\u0bb5\u0bc1\u0b95\u0bbf\u0bb1\u0ba4\u0bc1.",
        "analogy": "\u0baa\u0bbe\u0ba4\u0bc8 \u0bb5\u0bbf\u0ba4\u0bbf\u0b95\u0bb3\u0bcd \u0baa\u0bcb\u0bb2 \u0b87\u0bb2\u0b95\u0bcd\u0b95\u0ba3\u0bae\u0bcd \u0bae\u0bca\u0bb4\u0bbf\u0baf\u0bc8 \u0b9a\u0bbf\u0bb1\u0baa\u0bcd\u0baa\u0bbe\u0b95 \u0b85\u0bae\u0bc8\u0b95\u0bcd\u0b95\u0bc1\u0b95\u0bbf\u0bb1\u0ba4\u0bc1.",
        "explanation": [
            "\u0baa\u0bc6\u0baf\u0bb0\u0bcd, \u0bb5\u0bbf\u0ba9\u0bc8, \u0b89\u0bb0\u0bbf\u0b9a\u0bcd\u0b9a\u0bca\u0bb2\u0bcd \u0b86\u0b95\u0bbf\u0baf\u0bb5\u0bc8 \u0ba4\u0bae\u0bbf\u0bb4\u0bcd \u0b87\u0bb2\u0b95\u0bcd\u0b95\u0ba3\u0ba4\u0bcd\u0ba4\u0bbf\u0ba9\u0bcd \u0b85\u0b9f\u0bbf\u0baa\u0bcd\u0baa\u0b95\u0bc1\u0ba4\u0bbf.",
            "\u0b92\u0bb0\u0bc1 \u0bb5\u0bbe\u0b95\u0bcd\u0b95\u0bbf\u0baf\u0bae\u0bcd \u0b8e\u0ba9\u0bcd\u0baa\u0ba4\u0bc1 \u0b9a\u0bbf\u0ba8\u0bcd\u0ba4\u0ba9\u0bc8\u0baf\u0bc8 \u0bae\u0bc1\u0bb4\u0bc1\u0bae\u0bc8\u0baf\u0bbe\u0b95 \u0ba4\u0bc6\u0bb0\u0bbf\u0bb5\u0bbf\u0b95\u0bcd\u0b95\u0bc1\u0bae\u0bcd \u0b9a\u0bca\u0bb1\u0bcd\u0b95\u0b9f\u0bcd\u0b9f\u0bc1.",
            "\u0baa\u0bc6\u0baf\u0bb0\u0bcd \u0bae\u0bb1\u0bcd\u0bb1\u0bc1\u0bae\u0bcd \u0bb5\u0bbf\u0ba9\u0bc8 \u0b92\u0baa\u0bcd\u0baa\u0bbf\u0b95\u0bcd\u0b95 \u0bb5\u0bc7\u0ba3\u0bcd\u0b9f\u0bc1\u0bae\u0bcd.",
            "\u0b8e\u0bb4\u0bc1\u0ba4\u0bcd\u0ba4\u0bc1 \u0bae\u0bb1\u0bcd\u0bb1\u0bc1\u0bae\u0bcd \u0b92\u0bb2\u0bbf \u0bae\u0bc1\u0bb1\u0bc8 \u0bae\u0bc1\u0b95\u0bcd\u0b95\u0bbf\u0baf\u0bae\u0bcd.",
        ],
        "example": "\u0b8f\u0ba9\u0bcd \u0b8e\u0ba9\u0bcd\u0baa\u0ba4\u0bc1 \u0bb5\u0bbf\u0ba9\u0bc8, \u0baa\u0bc1\u0ba4\u0bcd\u0ba4\u0b95\u0bae\u0bcd \u0b8e\u0ba9\u0bcd\u0baa\u0ba4\u0bc1 \u0baa\u0bc6\u0baf\u0bb0\u0bcd.",
        "question": "\u201c\u0baa\u0ba3\u0bbf\u201d \u0b8e\u0ba9\u0bcd\u0baa\u0ba4\u0bc1 \u0baa\u0bc6\u0baf\u0bb0\u0bbe \u0bb5\u0bbf\u0ba9\u0bc8\u0baf\u0bbe?",
        "answer": ["\u0bb5\u0bbf\u0ba9\u0bc8"],
        "hint": "\u0b85\u0ba4\u0bc1 \u0b92\u0bb0\u0bc1 \u0b9a\u0bc6\u0baf\u0bb2\u0bc8\u0b95\u0bcd \u0b95\u0bc1\u0bb1\u0bbf\u0b95\u0bcd\u0b95\u0bc1\u0b95\u0bbf\u0bb1\u0ba4\u0bbe?",
        "revise": ["\u0baa\u0bc6\u0baf\u0bb0\u0bcd = \u0baa\u0bca\u0bb0\u0bc1\u0bb3\u0bcd.", "\u0bb5\u0bbf\u0ba9\u0bc8 = \u0b9a\u0bc6\u0baf\u0bb2\u0bcd.", "\u0b89\u0bb0\u0bbf\u0b9a\u0bcd\u0b9a\u0bca\u0bb2\u0bcd = \u0baa\u0bc1\u0ba3\u0bb0\u0bcd\u0baa\u0bc1.", "\u0b8e\u0bb4\u0bc1\u0ba4\u0bcd\u0ba4\u0bc1 \u0bae\u0bc1\u0b95\u0bcd\u0b95\u0bbf\u0baf\u0bae\u0bcd."],
        "mistakes": ["\u0baa\u0bc6\u0baf\u0bb0\u0bcd \u0bae\u0bb1\u0bcd\u0bb1\u0bc1\u0bae\u0bcd \u0bb5\u0bbf\u0ba9\u0bc8\u0baf\u0bc8 \u0b95\u0bc1\u0bb4\u0baa\u0bcd\u0baa\u0bbf\u0b95\u0bcd\u0b95\u0bb5\u0bbe\u0bae\u0bcd.", "\u0b92\u0bb2\u0bbf \u0bae\u0bc1\u0bb1\u0bc8 \u0b95\u0bb5\u0ba9\u0bae\u0bcd \u0b87\u0bb2\u0bcd\u0bb2\u0bbe\u0bae\u0bb2\u0bcd."],
        "trick": "\u0b9a\u0bc6\u0baf\u0bcd\u0baa\u0ba4\u0bc1 = \u0bb5\u0bbf\u0ba9\u0bc8 (\u0b9a\u0bc6\u0baf\u0bb2\u0bcd).",
        "advanced": "\u0bae\u0bc7\u0bae\u0bcd\u0baa\u0b9f\u0bcd\u0b9f \u0b87\u0bb2\u0b95\u0bcd\u0b95\u0ba3\u0ba4\u0bcd\u0ba4\u0bbf\u0bb2\u0bcd \u0ba4\u0bcb\u0ba4\u0bcd\u0ba4\u0bbf\u0bb0\u0bae\u0bcd, \u0bae\u0bbe\u0bb1\u0bcd\u0bb1\u0bae\u0bcd \u0baa\u0bcb\u0ba9\u0bcd\u0bb1 \u0b95\u0bb0\u0bc1\u0ba4\u0bcd\u0ba4\u0bc1\u0b95\u0bb3\u0bcd \u0b85\u0b9f\u0b99\u0bcd\u0b95\u0bc1\u0bae\u0bcd.",
    },
}


# Normalised index of the knowledge base: (_norm(subject), _norm(topic)) -> lesson.
_KB_NORM = {
    (_norm(s), _norm(t)): lesson for (s, t), lesson in _KB.items()
}


def _lookup_lesson(subject: str, topic: str):
    if not subject or not topic:
        return None
    key = (_norm(subject), _norm(topic))
    lesson = _KB_NORM.get(key)
    if lesson:
        return lesson
    # Lenient fallback: the topic may include extra words (e.g. "newtons laws
    # of motion" -> "newtons laws").
    for (s, t), lesson in _KB_NORM.items():
        if s == _norm(subject) and (t in _norm(topic) or _norm(topic) in t):
            return lesson
    return None


# ---------------------------------------------------------------------------
# Answer evaluation
# ---------------------------------------------------------------------------


def _matches(answer: List[str], student_reply: str) -> bool:
    if not answer:
        return False
    norm = _norm(student_reply)
    for cand in answer:
        cand_norm = _norm(cand)
        # exact or contained numeric/short answer
        if norm == cand_norm:
            return True
        if cand_norm in norm and len(cand_norm) >= 2:
            return True
        if norm in cand_norm and len(norm) >= 2:
            return True
    return False


def _has_numbers_only_but_wrong(message: str, answer: List[str]) -> bool:
    """Detect a numeric guess that isn't one of the accepted answers."""
    if re.fullmatch(r"-?\d+(\.\d+)?", message.strip()):
        return True
    return False


# ---------------------------------------------------------------------------
# Difficulty adaptation
# ---------------------------------------------------------------------------

DIFFICULTY_ORDER = ["beginner", "intermediate", "advanced"]
_ENCOURAGE = [
    "Exactly. \u2705 You got it right.",
    "That's correct \u2705 Nice work.",
    "Exactly right \u2705 You're on the ball.",
]
_ENCOURAGE_PARTIAL = [
    "You're on the right track. You've got part of it.",
    "Good effort — you're close. Let's sharpen it.",
]
_ENCOURAGE_WRONG = [
    "Not quite — but that's okay, that's exactly how learning works.",
    "Close, but not quite. No worries — let's see why.",
]


def _adapt_difficulty(current: str, correct: bool) -> str:
    idx = DIFFICULTY_ORDER.index(current) if current in DIFFICULTY_ORDER else 0
    if correct:
        return DIFFICULTY_ORDER[min(idx + 1, 2)]
    return DIFFICULTY_ORDER[max(idx - 1, 0)]


# ---------------------------------------------------------------------------
# Response builders
# ---------------------------------------------------------------------------


def _greeting(name: Optional[str]) -> str:
    if name:
        return (
            f"Hi {name}! I'm {ASSISTANT_NAME}, your personal learning assistant. \U0001F44B\n\n"
            "What are we studying today?"
        )
    return (
        f"Hi! I'm {ASSISTANT_NAME}, your personal learning assistant. \U0001F44B\n\n"
        "What are we studying today?"
    )


def _ask_subject() -> str:
    return "Sure! Which subject are you studying today?"


def _ask_topic(subject: str) -> str:
    return f"Nice. Which topic are you working on in {subject}?"


def _ask_goal(subject: str, topic: str) -> str:
    return f"Great — {topic} in {subject}. What would you like to do with this topic?"


def _build_lesson_message(lesson: Dict[str, Any], level: str, include_interaction: bool = True) -> str:
    lines = []
    lines.append(f"### The basic idea\n{lesson['definition']}")
    if lesson.get("intuition"):
        lines.append(f"\n### Think of it like this\n{lesson['intuition']}")
    if lesson.get("analogy"):
        lines.append(f"\n### A real-world picture\n{lesson['analogy']}")
    if level != "beginner":
        lines.append("\n### How it works")
        for step in lesson.get("explanation", [])[: 6 if level == "advanced" else 4]:
            lines.append(f"- {step}")
    if lesson.get("example"):
        lines.append(f"\n### Example\n{lesson['example']}")
    if include_interaction and lesson.get("question"):
        lines.append(f"\nNow let me check your understanding:\n\n**{lesson['question']}**")
    return "\n".join(lines)


def _build_revision_message(lesson: Dict[str, Any]) -> str:
    lines = ["Here's a quick, focused revision. \u23f1\ufe0f\n"]
    lines.append("### Key points")
    for b in lesson.get("revise", []):
        lines.append(f"- {b}")
    if lesson.get("trick"):
        lines.append(f"\n### Memory trick\n{lesson['trick']}")
    if lesson.get("mistakes"):
        lines.append("\n### Watch out for these common mistakes")
        for m in lesson.get("mistakes", [])[:3]:
            lines.append(f"- {m}")
    if lesson.get("question"):
        lines.append(f"\n### Quick check\n**{lesson['question']}**")
    return "\n".join(lines)


def _build_exam_message(lesson: Dict[str, Any]) -> str:
    lines = [
        "Okay, let's prepare strategically for your exam. \U0001F3AF\n",
        f"### {lesson['definition']}\n",
        "### What usually gets tested",
    ]
    for b in lesson.get("revise", [])[:4]:
        lines.append(f"- {b}")
    lines.append("\n### Common exam mistakes")
    for m in lesson.get("mistakes", [])[:3]:
        lines.append(f"- {m}")
    if lesson.get("trick"):
        lines.append(f"\n### Mnemonic to remember\n{lesson['trick']}")
    lines.append("\nWant me to give you a **practice question** or explain any part more deeply?")
    return "\n".join(lines)


def _build_doubt_message(lesson: Dict[str, Any]) -> str:
    lines = [
        f"Let's work through that doubt together.\n",
        f"### The key idea\n{lesson['definition']}\n",
        f"### Why it works\n{lesson['intuition']}\n",
        f"### Example\n{lesson['example']}",
    ]
    if lesson.get("question"):
        lines.append(f"\nDoes that clear it up? Quick check: **{lesson['question']}**")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def generate_tutor_response(
    message: str,
    email: str = "guest",
    conversation_history: Optional[List[Dict[str, Any]]] = None,
    tutoring_context: Optional[Dict[str, Any]] = None,
    student_context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Produce a tutoring response. Returns:
      {reply, suggestions, tutoringContext, pending, intent}
    """
    history = list(conversation_history or [])
    ctx = dict(tutoring_context or {})
    student = dict(student_context or {})
    name = student.get("name") or student.get("firstName") or student.get("username") or None

    message = (message or "").strip()

    # ---- Basic context object that will be returned ----
    def new_ctx(**overrides):
        base = {
            "subject": ctx.get("subject"),
            "topic": ctx.get("topic"),
            "goal": ctx.get("goal"),
            "level": ctx.get("level") or "beginner",
            "mode": ctx.get("mode") or "learn",
            "pending": ctx.get("pending"),
        }
        base.update({k: v for k, v in overrides.items() if v is not None})
        return base

    # ---- Timetable intents (kept from the original rule engine) ----
    from timetable import respond_timetable
    tt = respond_timetable(message, email)
    if tt:
        tt["tutoringContext"] = new_ctx()
        tt["intent"] = "timetable"
        return tt

    # ---- Emotion handling (before anything else) ----
    emotion = detect_emotion(message)
    if emotion and emotion in ("confused", "frustrated", "stuck", "succeeded") and ctx.get("topic"):
        # Only interject emotion for continued conversation, then keep teaching.
        reply = _EMOTION_REPLY[emotion]
        # If they're stuck/confused, offer a hint or simplification instead of a new question.
        if emotion in ("confused", "frustrated", "stuck"):
            ctx["mode"] = "learn"
            return {
                "success": True,
                "reply": reply,
                "suggestions": ["Give me a hint", "Explain it more simply", "Show a step-by-step example"],
                "tutoringContext": new_ctx(),
                "intent": "emotion",
            }
        return {
            "success": True,
            "reply": reply,
            "suggestions": [],
            "tutoringContext": new_ctx(),
            "intent": "emotion",
        }

    # ---- Detect/merge subject, topic, goal from the message ----
    subject = find_subject(message, ctx.get("subject"))
    topic = find_topic(message) or ctx.get("topic")
    goal = find_goal(message, ctx.get("goal"))

    # Detect a clear doubt / question that names a subject/topic.
    is_doubt = bool(find_goal(message, None) == "doubt") or any(
        w in message.lower() for w in ["?", "doubt", "what is", "why", "how does"]
    )

    # ---- Discovery flow: ask ONE question at a time ----
    if not subject:
        return {
            "success": True,
            "reply": _ask_subject(),
            "suggestions": DEFAULT_SUBJECT_SUGGESTIONS,
            "tutoringContext": new_ctx(goal=goal),
            "intent": "discover-subject",
        }
    if not topic:
        topics = _TOPIC_BY_SUBJECT.get(_norm(subject), [])
        suggestions = topics[:6] or ["Custom topic"]
        return {
            "success": True,
            "reply": _ask_topic(subject),
            "suggestions": suggestions,
            "tutoringContext": new_ctx(subject=subject, goal=goal),
            "intent": "discover-topic",
        }
    if not goal:
        return {
            "success": True,
            "reply": _ask_goal(subject, topic),
            "suggestions": [g["label"] for g in GOAL_OPTIONS],
            "tutoringContext": new_ctx(subject=subject, topic=topic),
            "intent": "discover-goal",
        }

    # ---- We have subject + topic + goal. Load the lesson. ----
    lesson = _lookup_lesson(subject, topic)

    if not lesson:
        # Generic tutor-structured fallback for unknown topics.
        m = message.lower()
        if any(w in m for w in ["know nothing", "nothing about", "don't know", "dont know", "very basics", "basics"]):
            return {
                "success": True,
                "reply": (
                    f"No problem — that's exactly where I love to start. Let's build **{topic}** in "
                    f"{subject} up from the very first brick.\n\n"
                    f"**Step 1** — define it: '{topic}' is a key idea in {subject} that you'll use "
                    f"over and over.\n\n"
                    f"To make it concrete: **can you think of any real-life situation where {topic} "
                    f"might show up?** Even a guess is a great starting point."
                ),
                "suggestions": ["Give me an example", "Explain the definition", "Give me a hint"],
                "tutoringContext": new_ctx(subject=subject, topic=topic, goal=goal, level="beginner"),
                "intent": "scaffold",
            }
        if any(w in m for w in ["fair bit", "some knowledge", "intermediate", "average"]):
            return {
                "success": True,
                "reply": (
                    f"Great — you've got a foundation. Let's strengthen **{topic}** in {subject}.\n\n"
                    f"Tell me one specific part of {topic} that feels shaky, and I'll target exactly that. "
                    f"Otherwise we can jump into a practice question to find your gaps."
                ),
                "suggestions": ["Give me a practice question", "Explain the key ideas", "Give me a hint"],
                "tutoringContext": new_ctx(subject=subject, topic=topic, goal=goal, level="intermediate"),
                "intent": "scaffold",
            }
        if any(w in m for w in ["good grip", "strong", "well", "advanced", "know it well"]):
            return {
                "success": True,
                "reply": (
                    f"Strong. Let's push **{topic}** in {subject} to the next level.\n\n"
                    f"Want a challenge question, an exam-style question, or to clear up a specific "
                    f"doubt? You lead — I'll adapt."
                ),
                "suggestions": ["Give me a practice question", "Exam prep", "Clear my doubt"],
                "tutoringContext": new_ctx(subject=subject, topic=topic, goal=goal, level="advanced"),
                "intent": "scaffold",
            }
        return {
            "success": True,
            "reply": (
                f"Let's make **{topic}** in {subject} simple together.\n\n"
                f"Start by telling me in your own words what you already know about {topic} — "
                "even one line helps me pitch the explanation at the right level."
            ),
            "suggestions": ["I know nothing", "I know the basics", "I know a fair bit", "I know it well"],
            "tutoringContext": new_ctx(subject=subject, topic=topic, goal=goal),
            "intent": "scaffold",
        }

    mode = goal if goal in ("learn", "practice", "exam", "revision", "doubt") else "learn"

    # ---- Hint request ----
    if "hint" in message.lower() or "clue" in message.lower():
        hint = lesson.get("hint") or "Try breaking the problem into smaller steps and re-read the question."
        return {
            "success": True,
            "reply": f"Here's a hint to point you the right way:\n\n{hint}",
            "suggestions": ["Give me another hint", "Show me the step-by-step solution"],
            "tutoringContext": new_ctx(subject=subject, topic=topic, goal=goal, mode=mode),
            "intent": "hint",
        }

    # ---- Evaluate an answer to a previously asked question ----
    pending = ctx.get("pending")
    if pending and isinstance(pending, dict) and pending.get("expected"):
        correct = _matches(pending.get("expected", []), message)
        current_level = ctx.get("level") or "beginner"
        if correct:
            level = _adapt_difficulty(current_level, True)
            msg = _ENCOURAGE[0]
            reply = f"{msg}\n\nYou correctly recognised the key idea for **{pending.get('label') or topic}**."
            if level != current_level and level in DIFFICULTY_ORDER:
                reply += f"\n\nSince you're doing well, I'll nudge the difficulty up a bit ({current_level} \u2192 {level})."
            if level == "advanced":
                reply += f"\n\n**Advanced point:** {lesson.get('advanced', '')}"
            # After a correct answer, invite the student to keep going via a fresh
            # practice question rather than repeating the identical check question.
            reply += (
                f"\n\nLet's keep the momentum. **{lesson.get('question')}** — "
                f"try it now, and if you'd rather switch it up, tap one of the options below."
            )
            new_pending = {"expected": lesson.get("answer", []), "label": topic}
            return {
                "success": True,
                "reply": reply,
                "suggestions": ["Give me a hint", "Give me a practice question", "Summarise this topic"],
                "tutoringContext": new_ctx(subject=subject, topic=topic, goal=goal, level=level, mode=mode, pending=new_pending),
                "intent": "evaluate-correct",
            }
        else:
            level = _adapt_difficulty(current_level, False)
            reply = (
                "Not quite — but that's okay, no one gets everything first try. \n\n"
                f"Let's see why. The key point for **{pending.get('label') or topic}**:\n"
                f"{lesson.get('intuition', '')}\n"
                f"\nTry again with that in mind, or grab a hint."
            )
            return {
                "success": True,
                "reply": reply,
                "suggestions": ["Give me a hint", "Try again"],
                "tutoringContext": new_ctx(subject=subject, topic=topic, goal=goal, level=level, mode=mode, pending=pending),
                "intent": "evaluate-wrong",
            }

    # ---- Mode-specific teaching ----
    if mode == "practice":
        q = lesson.get("question")
        return {
            "success": True,
            "reply": (
                "Let's practice — one question at a time, and I'll check each answer. \U0001F4DD\n\n"
                f"**Question 1:** {q}"
            ),
            "suggestions": ["Give me a hint", "Next question"],
            "tutoringContext": new_ctx(
                subject=subject, topic=topic, goal=goal, mode="practice",
                pending={"expected": lesson.get("answer", []), "label": topic},
            ),
            "intent": "practice",
        }

    if mode == "exam":
        return {
            "success": True,
            "reply": _build_exam_message(lesson),
            "suggestions": ["Practice questions", "Important concepts", "Revision summary"],
            "tutoringContext": new_ctx(subject=subject, topic=topic, goal=goal, mode="exam"),
            "intent": "exam",
        }

    if mode == "revision":
        return {
            "success": True,
            "reply": _build_revision_message(lesson),
            "suggestions": ["Practice questions", "Exam prep"],
            "tutoringContext": new_ctx(
                subject=subject, topic=topic, goal=goal, mode="revision",
                pending={"expected": lesson.get("answer", []), "label": topic},
            ),
            "intent": "revision",
        }

    if mode == "doubt" or is_doubt:
        return {
            "success": True,
            "reply": _build_doubt_message(lesson),
            "suggestions": ["That makes sense", "Give me a hint", "Give me a practice question"],
            "tutoringContext": new_ctx(
                subject=subject, topic=topic, goal=goal, mode="learn",
                pending={"expected": lesson.get("answer", []), "label": topic},
            ),
            "intent": "doubt",
        }

    # ---- Default: learn mode, step-by-step teaching ----
    level = ctx.get("level") or "beginner"
    return {
        "success": True,
        "reply": _build_lesson_message(lesson, level),
        "suggestions": ["Give me a hint", "Give me a practice question", "Summarise this"],
        "tutoringContext": new_ctx(
            subject=subject, topic=topic, goal=goal, level=level, mode="learn",
            pending={"expected": lesson.get("answer", []), "label": topic},
        ),
        "intent": "teach",
    }

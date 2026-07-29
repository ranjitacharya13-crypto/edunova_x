from pathlib import Path

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression


INTENTS = [
    "TIMETABLE_QUERY",
    "LIVE_CLASS_QUERY",
    "ASSIGNMENT_QUERY",
    "DOUBT_QUERY",
    "ADMIN_ANALYTICS_QUERY",
    "PERFORMANCE_PREDICTION",
]


def build_dataset():
    samples = [
        ("Show my next class", "TIMETABLE_QUERY"),
        ("When is my next lecture", "TIMETABLE_QUERY"),
        ("What is my timetable for today", "TIMETABLE_QUERY"),
        ("Do I have any class now", "TIMETABLE_QUERY"),
        ("Which subject is in period 3", "TIMETABLE_QUERY"),
        ("Class schedule for today", "TIMETABLE_QUERY"),
        ("Any live class running now", "LIVE_CLASS_QUERY"),
        ("List today's live classes", "LIVE_CLASS_QUERY"),
        ("Is there an active live session", "LIVE_CLASS_QUERY"),
        ("Show live lecture details", "LIVE_CLASS_QUERY"),
        ("What are the current online classes", "LIVE_CLASS_QUERY"),
        ("Which room is live right now", "LIVE_CLASS_QUERY"),
        ("Show my assignments", "ASSIGNMENT_QUERY"),
        ("Any pending assignment", "ASSIGNMENT_QUERY"),
        ("Evaluate this assignment", "ASSIGNMENT_QUERY"),
        ("Latest assignment for my class", "ASSIGNMENT_QUERY"),
        ("List assignment titles", "ASSIGNMENT_QUERY"),
        ("Give me assignment details", "ASSIGNMENT_QUERY"),
        ("I have a doubt in today's topic", "DOUBT_QUERY"),
        ("Help me understand this concept", "DOUBT_QUERY"),
        ("I need doubt support", "DOUBT_QUERY"),
        ("Can you explain this chapter", "DOUBT_QUERY"),
        ("I am confused in class", "DOUBT_QUERY"),
        ("Need help with subject question", "DOUBT_QUERY"),
        ("How many users are there", "ADMIN_ANALYTICS_QUERY"),
        ("Show system analytics", "ADMIN_ANALYTICS_QUERY"),
        ("Give me admin dashboard metrics", "ADMIN_ANALYTICS_QUERY"),
        ("Count students and teachers", "ADMIN_ANALYTICS_QUERY"),
        ("How many live classes happened", "ADMIN_ANALYTICS_QUERY"),
        ("Platform usage stats", "ADMIN_ANALYTICS_QUERY"),
        ("Predict my performance", "PERFORMANCE_PREDICTION"),
        ("Can you forecast my score", "PERFORMANCE_PREDICTION"),
        ("Am I improving academically", "PERFORMANCE_PREDICTION"),
        ("Estimate student performance", "PERFORMANCE_PREDICTION"),
        ("Will my result improve", "PERFORMANCE_PREDICTION"),
        ("Give performance prediction report", "PERFORMANCE_PREDICTION"),
    ]
    texts = [row[0] for row in samples]
    labels = [row[1] for row in samples]
    return texts, labels


def train_and_save(model_dir: Path):
    model_dir.mkdir(parents=True, exist_ok=True)

    texts, labels = build_dataset()
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), min_df=1)
    x_train = vectorizer.fit_transform(texts)

    clf = LogisticRegression(max_iter=1000, random_state=42)
    clf.fit(x_train, labels)

    joblib.dump(clf, model_dir / "intent_model.pkl")
    joblib.dump(vectorizer, model_dir / "vectorizer.pkl")

    return {"samples": len(texts), "intents": sorted(set(labels))}


if __name__ == "__main__":
    root = Path(__file__).resolve().parent
    stats = train_and_save(root / "models")
    print(f"Model trained with {stats['samples']} samples")
    print(f"Intents: {', '.join(stats['intents'])}")

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.demo import ensure_demo_db
from backend.introspect import introspect, sample_rows


class DemoDatabaseTests(unittest.TestCase):
    def test_demo_can_be_refreshed(self):
        first = ensure_demo_db(force=True)
        second = ensure_demo_db(force=True)

        self.assertEqual(first, second)
        self.assertTrue(second.is_file())
        self.assertEqual(introspect(str(second))["stats"]["tables"], 12)

    def test_sample_rows(self):
        path = ensure_demo_db()
        sample = sample_rows(str(path), "users", 3)

        self.assertEqual(len(sample["rows"]), 3)
        self.assertIn("email", sample["columns"])


class RelationshipTests(unittest.TestCase):
    def test_partial_composite_unique_is_not_one_to_one(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "relation.db"
            connection = sqlite3.connect(path)
            try:
                connection.executescript(
                    """
                    PRAGMA foreign_keys = ON;
                    CREATE TABLE parent (id INTEGER PRIMARY KEY);
                    CREATE TABLE child (
                        parent_id INTEGER NOT NULL REFERENCES parent(id),
                        variant TEXT NOT NULL,
                        UNIQUE (parent_id, variant)
                    );
                    """
                )
                connection.commit()
            finally:
                connection.close()

            schema = introspect(str(path))
            child = next(table for table in schema["tables"] if table["name"] == "child")
            self.assertFalse(child["foreignKeys"][0]["oneToOne"])

    def test_primary_key_foreign_key_is_one_to_one(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "relation.db"
            connection = sqlite3.connect(path)
            try:
                connection.executescript(
                    """
                    PRAGMA foreign_keys = ON;
                    CREATE TABLE parent (id INTEGER PRIMARY KEY);
                    CREATE TABLE profile (
                        parent_id INTEGER PRIMARY KEY REFERENCES parent(id)
                    );
                    """
                )
                connection.commit()
            finally:
                connection.close()

            schema = introspect(str(path))
            profile = next(table for table in schema["tables"] if table["name"] == "profile")
            self.assertTrue(profile["foreignKeys"][0]["oneToOne"])


if __name__ == "__main__":
    unittest.main()

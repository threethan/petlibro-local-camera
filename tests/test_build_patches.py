"""Docker copies patch bytes directly; Linux Git requires LF context lines."""

from pathlib import Path
import re
import unittest


class BuildPatchTests(unittest.TestCase):
    def test_docker_patch_inputs_use_lf_line_endings(self):
        addon = Path(__file__).parents[1] / "addon"
        dockerfile = (addon / "Dockerfile").read_text()
        patches = re.findall(r"^COPY (\S+\.patch) ", dockerfile, re.MULTILINE)
        self.assertTrue(patches, "No bridge patch inputs found")
        for name in patches:
            with self.subTest(patch=name):
                data = (addon / name).read_bytes()
                self.assertNotIn(
                    b"\r", data,
                    "CRLF patch context fails against Docker's LF Git checkout",
                )


if __name__ == "__main__":
    unittest.main()

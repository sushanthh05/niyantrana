"""Deploy readiness check for the inference service.

Run before pushing a deploy. Catches the failure modes that produce a *silently
wrong* service rather than a failed build:

* an artifact that is a Git LFS pointer stub instead of the real file, which
  loads as 130 bytes of text and yields an empty model or an empty food database
* an artifact missing from the commit, so the image build fails on a fresh clone
  even though it works locally
* a model that is present but cannot actually be loaded and scored

Usage:  python scripts/preflight.py
"""
import os
import subprocess
import sys

ML_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# path relative to ml/, required for the image to work
ARTIFACTS = [
    ("models/risk_engine.joblib", True),
    ("models/risk_classifiers.joblib", True),
    ("data/raw/anuvaad_indb_2024.11.csv", True),
    ("requirements-serve.txt", True),
    ("Dockerfile", True),
]

LFS_POINTER_PREFIX = b"version https://git-lfs.github.com"


def check_present_and_real(rel_path):
    """Exists, is not an LFS pointer stub, and is a plausible size."""
    full = os.path.join(ML_ROOT, rel_path)
    if not os.path.exists(full):
        return f"MISSING from the working tree: {rel_path}"

    with open(full, "rb") as handle:
        head = handle.read(64)
    if head.startswith(LFS_POINTER_PREFIX):
        return (f"{rel_path} is a Git LFS POINTER, not the file. A build host that "
                "does not fetch LFS objects will copy this stub and the service "
                "will load empty data without erroring.")

    size = os.path.getsize(full)
    if size < 1024:
        return f"{rel_path} is only {size} bytes -- almost certainly not the real artifact"
    return None


def check_committed(rel_path):
    """In HEAD, so a fresh clone (which is what the build host does) has it."""
    repo_path = f"ml/{rel_path}"
    result = subprocess.run(
        ["git", "cat-file", "-e", f"HEAD:{repo_path}"],
        cwd=os.path.dirname(ML_ROOT), capture_output=True)
    if result.returncode != 0:
        return (f"{rel_path} is NOT committed. It exists locally, so the image builds "
                f"here and fails on the build host. Commit it: git add {repo_path}")
    return None


def check_model_loads():
    """Presence is not readiness -- load the models and score a profile."""
    sys.path.insert(0, ML_ROOT)
    cwd = os.getcwd()
    try:
        os.chdir(ML_ROOT)
        from src.inference.artifacts import functional_check  # noqa: PLC0415

        probe = functional_check()
        if not probe["functional"]:
            return f"the model stack does not work: {probe.get('error')}"
        return None
    except Exception as exc:
        return f"could not run the functional probe: {type(exc).__name__}: {exc}"
    finally:
        os.chdir(cwd)


def main():
    problems = []

    print("Checking deploy artifacts...")
    for rel_path, required in ARTIFACTS:
        for check in (check_present_and_real, check_committed):
            issue = check(rel_path)
            if issue:
                if required:
                    problems.append(issue)
                else:
                    print(f"  WARN {issue}")
                break
        else:
            print(f"  OK   {rel_path}")

    print("\nChecking the model stack actually loads...")
    issue = check_model_loads()
    if issue:
        problems.append(issue)
    else:
        print("  OK   models load and score")

    if problems:
        print(f"\n{len(problems)} problem(s) would break or silently degrade the deploy:\n")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print("\nReady to deploy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# Codebase Restructure — decisions mapped to refactoring.guru

Scope: `ml/` and `backend2/`. The frontend is excluded — it is being replaced wholesale.

A note on method: patterns were applied where a real problem in *this* codebase called for one. Applying the remaining GoF patterns for completeness would itself be a smell — **Speculative Generality** — so several are deliberately absent, and that is recorded at the end.

---

## 1. Code smells found and removed

| Smell | Where it was | Fix |
|---|---|---|
| **Long Method** | `apiRoutes.js` `/predict` — 138 lines doing 7 jobs | Split across `RiskService`, `InferenceClient`, `riskController` |
| **Large Class** | `apiService.jsx` (772 lines, 8 namespaces) | Out of scope (frontend), but flagged |
| **Primitive Obsession** | An 11-key untyped `user_data` dict threaded through every layer | `UserProfile`, `WearableWindow`, `Biomarkers` value objects |
| **Data Clumps** | `{age, gender, bmi, waist, ...}` passed together everywhere | **Introduce Parameter Object** → `UserProfile` |
| **Long Parameter List** | `predict_risk(time_series_data, tabular_data)` plus implicit globals | Constructor-injected collaborators |
| **Duplicate Code** | Fatty Liver Index implemented **4×** (JS route, Python predict, notebook, docs); Mifflin-St Jeor **2×**; `isAuthenticated` **2×**; `escapeRegex` **2×** | One definition each: `domain/models.py`, `domain/metabolic.js`, `middleware/authenticate.js`, `domain/text.js` |
| **Dead Code** | `healthReportSchema` never written to; `models/data_scaler.pkl` unreferenced; `main.py` and `02_Model_Prototyping.ipynb` 0 bytes | Deleted, or wired up (`healthHistory` is now populated) |
| **Divergent Change** | Adding a second disease would have meant editing the same Express handler again | `RiskScorer` strategies — a new condition adds a class, edits nothing |
| **Shotgun Surgery** | Changing the ML URL meant touching route code; changing the port meant editing `server.js` | `config/env.js` — one place |
| **Feature Envy** | Route handlers calling `User.findById`, `user.save()`, building `$regex` | Repositories |
| **Middle Man** / **Message Chains** | `user.healthHistory[user.healthHistory.length - 1].biomarkers.triglycerides` | Repository methods; `canBeAssessed()` on the model |
| **Switch Statements** | `if (mlData.predicted_triglycerides) ... else if (mlData.TG) ... else <random>` | One validated contract in `InferenceClient` |
| **Comments** (compensating for bad code) | `// ... plus all other fields your model requires like calorie_intake, etc.` | The comment described a bug; the bug is fixed and the comment is gone |
| **Temporary Field** | `tabular_features_with_gender` computed and never used | Removed |
| **Inappropriate Intimacy** | `predict.py` mutated its caller's DataFrame in place | Frozen dataclasses |

---

## 2. Design patterns applied, and why

### Creational

**Factory Method** — `UserProfile.from_dict`, `WearableWindow.from_records`, `BiomarkerPredictor.from_registry`, `RiskAssessor.build`.
The Express backend still speaks the legacy vocabulary (`calorie_intake`, `gender`, `waist`). Factory methods absorb that translation at one boundary so legacy names never leak into the domain, and the two services can be migrated independently.

**Singleton** — `ModelRegistry.instance()`, `FoodRepository.instance()`.
Model weights and a 1,014-row spreadsheet should be loaded once per process. Both use double-checked locking, and both expose `reset()` so tests are not stuck with a process-wide fixture — a plain module-level global (the v1 approach) could not be swapped.

### Structural

**Adapter** — `InferenceClient` (Node → Python service), `GeminiClient` (→ vendor SDK).
Swapping the LLM provider or the inference transport now touches one class. `genai.configure()` used to run at import scope.

**Facade** — `RiskAssessor`, `RecommendationEngine`, `RiskService`, `src/domain/__init__.py`.
Callers make one call. They do not need to know a registry loads artifacts, a bridge assembles features, a backend runs a graph, and three strategies interpret the output.

**Flyweight** (in spirit) — `FoodRepository` shares one parsed food table across all requests.

### Behavioral

**Strategy** — two independent hierarchies:
- `InferenceBackend` → `OnnxBackend` / `KerasBackend` / `SklearnBackend`. Serving must not import TensorFlow (358 MB RSS vs 33 MB), but training needs it. Strategy lets both coexist.
- `RiskScorer` → `FattyLiverScorer` / `DysglycaemiaScorer` / `HypertensionScorer`. This is what makes the deck's "jointly predicts all three conditions" claim reachable without an `if` cascade.

**Template Method** — `RiskScorer.score()`.
Fixes the invariant skeleton (compute → clamp → band → package **with provenance**) so no scorer can emit a number without declaring its origin. Subclasses vary only `_compute`, `_rationale`, `_contributors`.

**Chain of Responsibility** — `errorHandler.js` and the FastAPI exception handlers.
One translator from the domain error hierarchy to HTTP status codes, replacing try/catch blocks copy-pasted into every handler.

**Null Object** — a `RecommendationEngine` without an API key reports itself unavailable instead of `exit()`-ing at import and taking `/predict` down with it.

---

## 3. SOLID

| Principle | Application |
|---|---|
| **Single Responsibility** | `predict_risk` did validation, assembly, scaling, reshaping, inference and inverse-transform. Now: domain validates, `FeatureBridge` assembles, `InferenceBackend` runs, `BiomarkerPredictor` orchestrates. |
| **Open/Closed** | A fourth disease = one new `RiskScorer` subclass + one registry entry. No existing class changes. |
| **Liskov Substitution** | Every `InferenceBackend` honours the same contract, including raising `InferenceError` rather than returning a sentinel. |
| **Interface Segregation** | `InferenceBackend` has one method. Consumers of the food database depend on `FoodRepository`, not on pandas. |
| **Dependency Inversion** | `BiomarkerPredictor`, `RiskAssessor`, `RiskService` and all Node services take collaborators through constructors with production defaults. `domain/` imports nothing from the layers above it. |

---

## 4. Individual refactorings

| Technique | Applied to |
|---|---|
| **Extract Class** | Routes → controller / service / repository; `predict_risk` → domain + bridge + backend + predictor |
| **Extract Method** | `asyncHandler`, `authenticate`, `escapeRegex`, `RiskService.toProfilePayload` |
| **Move Method** | Mifflin-St Jeor from `userRoutes.js` → `domain/metabolic.js` and `UserProfile.basal_metabolic_rate` |
| **Replace Method with Method Object** | `predict_risk` → `BiomarkerPredictor` |
| **Introduce Parameter Object** | `UserProfile`, `WearableWindow` |
| **Replace Data Value with Object** | `Biomarkers`, `RiskScore`, `RiskAssessment` |
| **Replace Type Code with Class** | `Provenance`, `RiskBand`, `Sex` enums |
| **Replace Magic Number with Symbolic Constant** | `FLI_STEATOSIS_THRESHOLD`, `HBA1C_DIABETES`, `SYSTOLIC_HYPERTENSION`, `SEQUENCE_LENGTH` |
| **Replace Error Code with Exception** | Both error hierarchies, replacing `exit()` / `None` / random substitution |
| **Replace Conditional with Polymorphism** | Response-shape `if/else` → one contract; scorer `if` cascade → strategies; `COLUMN_SOURCES` lookup table |
| **Replace Nested Conditional with Guard Clauses** | `RiskService.assess`, `AuthService.register` |
| **Replace Temp with Query** | `total_energy_expenditure`, `energy_balance`, `mvpa_minutes_week` as properties |
| **Encapsulate Field** | Frozen dataclasses; `password` and Fitbit tokens `select: false` |
| **Encapsulate Collection** | `WearableWindow.days` is a tuple with invariants, not a bare list |
| **Hide Delegate** | Repositories hide Mongoose; `domain/__init__.py` hides module layout |
| **Introduce Assertion** | `assertValidConfig()` fails a production boot on a weak session secret |
| **Rename Method** | `predict_risk` → `BiomarkerPredictor.predict`; `data_processing` → `data/synthetic`; `recommender` → `recommendation/engine` |

---

## 5. The rule the architecture now enforces

Every emitted number carries a `Provenance`. It is a required constructor argument on `RiskScore`, a required field on `AssessmentResponse`, and a required Mongoose field on `healthReportSchema` — so a score **cannot be persisted or returned without declaring where it came from**.

This is a structural response to the worst defect in v1, which returned `Math.random()` as a health risk assessment in three separate places, always with HTTP 200:

| v1 | v2 |
|---|---|
| `apiRoutes.js` → `TG: 150 + Math.random() * 50` on any failure | `InferenceClient` throws `InferenceUnavailableError` → HTTP 503 |
| Empty wearable history → 14 fabricated days | `ValidationError` naming how many days exist |
| Missing FLI inputs → the literal `50` | `fattyLiverIndex()` returns `null`; the scorer abstains |
| `apiService.jsx` → `Math.random() * 100` | (frontend, out of scope) |

Locked by `test_failed_inference_raises_rather_than_substituting`.

---

## 6. Patterns deliberately NOT applied

Recording these matters as much as the ones used — reaching for a pattern without a problem is **Speculative Generality**.

| Pattern | Why not |
|---|---|
| **Abstract Factory** | One product family. `Factory Method` suffices. |
| **Builder** | `UserProfile` has sensible defaults; a fluent builder would add ceremony over a dataclass. |
| **Prototype** | Frozen dataclasses; nothing needs cloning. |
| **Bridge** | Strategy already decouples execution; a second axis of variation does not exist yet. |
| **Composite** | The scorer collection is a flat tuple, not a tree. |
| **Decorator** | Considered for provenance tagging; a required field on the value object is simpler and unavoidable. |
| **Proxy** | Lazy loading is handled by the registry; a proxy would duplicate it. |
| **Command / Memento / Visitor / Mediator / Iterator / State** | No undo, no snapshots, no stable-structure-varying-operations, no many-to-many coordination, no custom traversal, no state machine. |
| **Observer** | The system is request/response. Warranted later if alerts (deck slide 13) are built. |

---

## 7. Verification

```bash
cd ml && python -m pytest tests/ -q          # 19 passed
cd backend2 && npm run lint                  # all 24 modules parse
```

The serving path is checked to import neither TensorFlow nor onnxruntime at module load — everything is deferred, so `/health` answers even when artifacts are absent.

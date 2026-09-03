# Context

Shared vocabulary for this repository. Every term here has exactly one meaning in code, tests, issues and commit messages. The application's interface is in French; French surface terms are given in italics beside the English term used in code and prose.

## The domain

**Sophrologist** — the single human who uses the application. Also the owner of the deployment and of the transcription account. There is one of them; there are no user accounts, roles or permissions.

**Session** _(séance)_ — one sophrology session. It has exactly one terpnos logos and, once recorded, exactly one recording.

**Terpnos logos** — the complete text the sophrologist writes for a session, and reads aloud to produce the recording. In prose, always written in full: never "the script", never "the text". Its paragraphs, line breaks and punctuation carry the breathing and pacing of the session and are part of its meaning.

**Recording** — the audio file of the sophrologist reading the terpnos logos. One file, typically 20–40 minutes.

**Transcript** — what the transcription provider heard in the recording: an ordered sequence of spoken words, each carrying the moment it was spoken. The transcript is a machine artefact and is never shown to the sophrologist directly.

**Report** _(rapport)_ — the output of the application. The terpnos logos as written, with every difference marked inside it. The report is built on the terpnos logos, never on the transcript: it is meant to be copied out and become the next version of the terpnos logos, so the author's own punctuation must survive.

## Differences

**Difference** — a place where the recording and the terpnos logos disagree. The umbrella term. A difference is always either an addition or an omission; there is no third kind, and a substitution is expressed as an omission followed by an addition.

**Addition** — words present in the recording but not in the terpnos logos. Improvisations, repeated sentences, hesitations. Never "insertion".

**Omission** — words present in the terpnos logos but absent from the recording. A skipped passage. Never "deletion" or "missing".

**Hesitation** — a disfluency actually voiced by the sophrologist ("euh", "hum"). A hesitation is a kind of addition, not a category of its own: it is reported rather than filtered out, because it marks a passage worth re-recording.

**Noise** — a difference the machine can see but the sophrologist does not care about: a spelled-out number against a digit, an accent, a capital, an apostrophe, a hyphen in a compound word, the "œ" ligature. Noise is not a difference and never appears in the report.

**Normalisation** — reducing two words to the form in which they count as the same word. Normalisation exists solely to eliminate noise. It applies to the comparison only: the report always displays the original text.

## The document

**Non-spoken content** — parts of the terpnos logos that were never meant to be read aloud: production headers, section headings, working abbreviations. The sophrologist marks them explicitly. Non-spoken content takes no part in the comparison and can therefore never be reported as an omission, but it remains visible in the report so the structure of the document survives.

**Spoken content** — everything in the terpnos logos that is not non-spoken content. This is the only text compared against the transcript.

## Deliberately absent

These have no term because the product does not have the concept. Listed so that nobody invents vocabulary for them:

- **No score.** There is no fidelity, no accuracy and no completeness. The tool informs; it does not grade.
- **No history.** There is no past session, no archive and no library. A session is processed and gone.
- **No user.** There is no account, no role and no permission. The sophrologist is the only person the domain knows about.

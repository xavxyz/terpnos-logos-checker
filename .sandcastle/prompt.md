You are implementing one GitHub issue in the `terpnos-logos-checker` repository,
autonomously, with no human available to answer questions.

## Your issue

Issue number: {{ISSUE_NUMBER}}

Title: {{ISSUE_TITLE}}

{{ISSUE_BODY}}

## The parent specification

Every issue is a slice of issue #1, which holds the decisions all slices share.
Read it before you write any code; it is the authority when your issue is
ambiguous.

{{PARENT_SPEC}}

## Rules

**Vocabulary.** Read `CONTEXT.md` at the repository root first and use its terms
exactly — in identifiers, test names, comments and commit messages. It is the
shared glossary for every issue in this project. If you need a domain concept it
does not define, you are probably inventing language the project does not use:
prefer an existing term.

One deliberate exception: issue #1 fixes the seam's parameter name as `script`,
and issue #3 repeats it. Keep that name so the signature matches the spec, even
though prose everywhere else says "terpnos logos".

**Scope.** Implement your issue and nothing else. Do not start work described by
another issue, even if it looks trivial and adjacent. Do not refactor code
outside your issue's scope. Do not edit `.sandcastle/` — that is the harness
running you, and changing it has no effect on this run.

**Testing.** Issue #1 fixes one testing seam for the whole project:

```
buildReport({ script, transcript }) -> string (HTML)
```

Below that seam the code is pure and deterministic, and is tested by supplying a
hand-written transcript and asserting on the rendered output. Above it —
password check, blob upload, transcription calls, polling, progress UI — is
orchestration over network I/O and is deliberately **not** unit-tested. Do not
add tests above the seam. Do not write tests that reach into the tokeniser, the
diff operations or the normalisation table: those must stay free to be
rewritten.

**The gate.** Before you finish, all three of these must pass from a clean
checkout. Run them yourself and fix what they report:

```
npm run typecheck
npm test
npm run build
```

If you cannot get all three green, say so honestly in your verdict rather than
weakening a test, skipping a test, or loosening a type to make them pass.
Deleting or `.skip`-ing a failing test to reach green counts as a failed gate.

**Committing.** Commit your work with a clear message referencing
`#{{ISSUE_NUMBER}}`. Leave no uncommitted changes in the working tree. Do not
push, do not open a pull request, and do not touch the issue on GitHub — the
harness on the host does all of that after this run ends.

**Language.** All user-facing interface text is French. Code identifiers,
comments, commit messages and your verdict are English.

## When you are done

Work through your issue's acceptance criteria one at a time and verify each one
against the code you actually wrote — not against what you intended to write.

Then emit your verdict as the last thing you output, in exactly this form:

<verdict>
{
  "gates": { "typecheck": true, "tests": true, "build": true },
  "criteria": [
    { "text": "<the acceptance criterion, verbatim from the issue>", "met": true, "note": "" }
  ],
  "summary": "<two or three sentences: what you built and anything the reviewer should look at>"
}
</verdict>

Every acceptance criterion from your issue must appear in `criteria`, in the
order the issue lists them. Set `met` to `false` for anything you did not fully
implement and explain why in `note`. An honest `false` is useful; a `true` you
cannot justify breaks the pipeline that trusts this verdict to merge your work.

Then output <promise>COMPLETE</promise>

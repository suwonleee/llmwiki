# llmwiki privacy policy

Effective date: October 19, 2026

llmwiki is a local-first, open-source project wiki. It has no hosted service, account system,
telemetry, advertising, or analytics. The plugin makes no network requests.

## Data processed

- Wiki Markdown from the repository you explicitly enroll.
- Local derived state: the search index, capture queue, emitted page paths and content hashes,
  a bounded Git commit-message cache, and explicit page-use feedback and recheck receipts.
- Automatic retrieval reads local wiki pages and commit messages. A bounded search of tracked
  files at HEAD can check whether a named subject appears. Private temporary files cache parsed
  wiki pages and retain only prompt hashes and flags for a once-per-session save hint.
- The incremental, task-relevant portion of session transcripts only when you invoke `wiki-save`
  or `wiki-deep`. Automatic hooks inspect transcript modification times, not transcript content.
  Transcript material is credential-screened before it is printed back into model context, and
  secret-only fragments are omitted.

llmwiki does not request payment data, health data, government identifiers, credentials, or
authentication secrets. If credential-shaped material already exists in a local transcript, the
engine replaces it before the extract reaches model context and checks generated wiki content
again before it can become durable. You remain responsible for reviewing content before publishing
a wiki.

## Purpose

The data is processed only to build, search, inject, quiz, diagnose, and maintain the project wiki
you requested. Repositories are opt-in; unenrolled repositories receive no injected output.

## Recipients and transfers

There are no llmwiki-operated recipients and no llmwiki-operated external transfers. Processing
happens on your machine. If you commit or push `docs/wiki`, your chosen Git host and collaborators
receive those Markdown files under the permissions and terms you configure with that service.

## Retention

Wiki Markdown remains in your repository until you edit or delete it. Derived state remains in the
platform state directory, normally `~/.local/share/llmwiki`, until you delete it. llmwiki does not
retain a server-side copy because it operates no server.

## Your controls

You choose which repositories to enroll, when transcript content may be read by invoking a save or
deep-pass skill, whether wiki Markdown is committed, and when to disable or uninstall llmwiki. Run
`llmwiki disable <repo>` to revoke enrollment. Uninstalling the plugin leaves your Markdown intact;
delete the llmwiki state directory if you also want to remove derived local state.

Use `LLMWIKI_TURN_COMMITS=off`, `LLMWIKI_TURN_ABSENT=off`, `LLMWIKI_PAGE_CACHE=off`, or
`LLMWIKI_SAVE_NUDGE=off` to disable the corresponding retrieval channel, parsing cache, or save hint.
Feedback is collected only during explicit close-out. Missing or unknown feedback is neutral.

## Contact

For privacy questions, open a GitHub issue without including private data:
https://github.com/suwonleee/llmwiki/issues

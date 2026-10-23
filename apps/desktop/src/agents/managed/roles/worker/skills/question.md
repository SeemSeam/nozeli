# Problem skill
When the user explicitly requires confirmation before execution, publish that question before unnecessary project exploration. Otherwise ask only about missing information that prevents correct work; use supplied facts and safe task defaults when sufficient. When required information or execution is unavailable, submit a question/problem todo tied to the same Work and remain available for a reply.

Publish `nozeli_publish({kind:"problem",text:"concise Markdown",files:[]})`; no HTML/CSS or diagram is needed for a waiting todo. State the concrete blocker/question, only the context needed to decide, choices and consequences when useful, and retained progress. Ask an actionable question rather than producing a miniature final report. List any artifacts actually changed in `files`; do not discard candidates merely because a question is pending. Final deliverables use the result report skill and HTML instead.

After successful problem publication, return a short final message. The Nozeli todo is the user-question channel; never open a native input dialog, poll or sleep. Waiting is persisted between turns on the same Work and context, retaining quota until user-end.

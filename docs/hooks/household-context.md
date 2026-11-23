# Hook: household-context

A few lines about who eats in this kitchen, for Ask to keep in mind: who is at the table, what they don't eat, what they like. With it, an answer about a substitution or a menu can take the household into account without the cook saying so each time.

As shipped this hook is unconnected: Ask knows only the recipe in hand and what the cook types.

## Interface

From `app/src/lib/hooks/types.ts`:

```ts
export interface HouseholdContext {
  /**
   * A few lines of free text about the household for Ask to keep in mind:
   * who eats here, what they avoid, what they like. Placed in the model's
   * reference information as written. "" when there is nothing to say.
   */
  read(): Promise<string>;
}
```

## `read()`

- **Input:** none.
- **Output:** free text, a few lines. The app trims it and, if anything is left, puts it in the system prompt of every Ask message as its own section of the reference information, under the model's instructions and the recipe.
- **Empty:** `""` (or only whitespace) means there is nothing to say; the section is left out.
- **Errors:** reject when the store can't be read. Ask treats a rejected read as nothing to say and answers anyway, so a broken store costs the context, not the answer.
- **Idempotency:** a pure read. The app never writes this text.
- **Time:** bound it, and keep it fast. The read is awaited before every Ask message is sent to the model, so a slow store slows every answer. Cache inside your implementation if the store is remote.
- **Length:** there is no cut. Whatever is returned is sent with every message and paid for in input tokens, so keep it to a short paragraph.

## What happens to the text

This is the part to read before connecting it.

- **It is sent to your model provider.** The text goes, as written, to whichever provider is configured (`docs/environment.md`) on every message the cook sends to Ask. The provider's data-handling terms apply to it.
- **It is stored.** Each message the cook sends to Ask is logged to the `conversation_logs` table with the context it was sent with, this text included.
- **It is not cleaned.** Unlike a cook's note from the cook log, this text is inserted without escaping or a length limit. Whoever can edit the store can put instructions in front of the model. Keep the store somewhere only the household can write.
- **Anyone who can reach the app can ask about it.** The app has no login. A person on the same network can open Ask and ask what it knows about the household.

So write the minimum that makes answers better: "Four of us, one vegetarian. Nobody here eats cilantro. We like food hot." Leave out names, medical details and anything else you would not put in an email to the provider. A plain preference ("no shellfish") does the same work in the prompt as the reason behind it.

## Where the app calls it

| Call | Where | Triggered by |
| --- | --- | --- |
| `read()` | The context builder (`getNotionContext`) in `app/src/lib/claude.ts`, behind the `chatCooking` procedure in `app/src/server/routers/_app.ts` | Every message sent to Ask, from the home screen or from a cook (`app/src/components/kitchen/AskSous.tsx`) |

Nothing else reads it. It has no screen of its own.

## What the cook sees

**Unconnected.** Ask answers from the recipe being cooked, the cook's place in it and its timers. Nothing is read.

**Connected.** Nothing changes on screen. Ask's answers take the text into account when it bears on the question: asked for a substitute, it won't suggest one the household avoids.

The same reference information also carries the pantry lines and the recent cooks when the `pantry` and `cook-log` hooks are connected (`docs/hooks/pantry.md`, `docs/hooks/cook-log.md`). The three are independent.

## A minimal implementation

A text file beside the app, or a single environment variable, returned as is. The text changes a few times a year, so there is no need for a database.

The author's deployment kept it as one section of the same shared document as the pantry, so the household could edit it by hand.

## Connecting it

1. Write an object that satisfies `HouseholdContext`.
2. Put it in the `"household-context"` slot of `implementations` in `app/src/lib/hooks/registry.ts` (shipped as `null`).
3. Set `"household-context"` to `true` in `connected` in `app/src/lib/hooks/connected.ts`.

The app reaches the implementation through `hook("household-context")` in `registry.ts`, and only after checking `connected["household-context"]`. With the switch on and the slot still `null`, the first use throws `The "household-context" hook is switched on in lib/hooks/connected.ts but has no implementation in lib/hooks/registry.ts. Its spec is docs/hooks/household-context.md.` Ask catches that error like any failed read, logs it and answers without the context, so for this hook the message appears in the server log, not on screen. With the switch off, the implementation is never called.

## Acceptance checklist

- [ ] Return "Nobody here eats cilantro." and ask Ask, during any cook, what herb to finish the dish with: the answer avoids cilantro.
- [ ] After that message, the newest `user` row in `conversation_logs` has the text in its `context` column.
- [ ] Return `""`: Ask answers as it does unconnected.
- [ ] Make `read()` reject: Ask still answers, without the context.
- [ ] Make `read()` take five seconds: every Ask answer is five seconds slower. Then add your cache and check it isn't.
- [ ] Read "What happens to the text" again and check the text against it.
- [ ] Switch the hook off again: `read()` is no longer called.

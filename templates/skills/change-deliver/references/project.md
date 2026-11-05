# Project context for delivery

Use the installed native workflow to locate the exact change and its approval, task status and prerequisites before applying it.

For OpenSpec, use the state in its native apply instructions. When it reports ready with an omitted planning artifact, confirm the artifact instructions explicitly allow that omission and proceed within the approved scope. A blocked state needs its native recovery step.

Read the source for each applicable rule and the commands in the nearest project manifest. Check hook configuration for its actual entry and trigger. A configured hook counts as verification once it has run for the intended input. Record manually run checks separately.

Keep failed and unrun checks visible when handing off. A successful check provides evidence for the scope it exercised.

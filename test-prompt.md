# Claude MCP in Fayar kitsune — Integration Test Prompt

Copy and paste everything below the line into a new Claude Code session that has the `open-claude-in-fayarkitsune` MCP configured. reddit.com blocks `eval()`, so steps 23, 26 and 27 need the extension's optional "User scripts" permission: allow it from the extension's toolbar button first. Step 42 asks you to confirm a file upload; either answer counts.

---

You are running an integration test for a Firefox browser automation extension. Your job is to execute every step below and use the specific MCP tool listed for each step. Do NOT skip any tool — every single one must be called at least once.

Execute these steps in order:

## Tab Management
1. Call `tabs_context_mcp` with `createIfEmpty: true` to get current tabs.
2. Call `tabs_create_mcp` to create a new tab. Record its tab ID as TAB_1.
3. Call `tabs_create_mcp` again to create a second tab. Record its tab ID as TAB_2.

## Navigation + Window
4. Call `navigate` to go to `https://www.reddit.com` in TAB_1 with `wait: "networkidle"`. (This domain is blocked in Anthropic's official Chrome extension — if this works, the unrestricted Firefox extension is functioning.)
5. Call `resize_window` to set the window to 1280x800 using TAB_1.

## Screenshots + Reading
6. Call `computer` with action `screenshot` on TAB_1.
7. Call `computer` with action `screenshot` on TAB_1 again, with `if_changed: true`. (Expected: "Unchanged" without an image, unless the page changed in between; either counts.)
8. Call `read_page` on TAB_1 with filter `"all"` to get the accessibility tree.
9. Call `read_page` on TAB_1 with filter `"all"` and `delta: true`. (Expected: "Unchanged", or only the lines that changed.)
10. Call `get_page_text` on TAB_1 to extract the text content.

## Finding + Form Input
11. Call `find` with query `"search"` on TAB_1 to locate the search input.
12. Call `form_input` on TAB_1 using the ref from step 11 to set the search value to `"MCP server"`.

## Mouse + Keyboard Actions
13. Call `computer` with action `left_click` on TAB_1 at the coordinates of the search input (from step 11).
14. Call `computer` with action `key` on TAB_1 with text `"Enter"` to submit the search.
15. Call `computer` with action `wait` on TAB_1 with duration `3` to wait for results.
16. Call `computer` with action `scroll` on TAB_1 with scroll_direction `"down"` and scroll_amount `3` at coordinates `[640, 400]`.
17. Call `computer` with action `hover` on TAB_1 at coordinates `[640, 300]`.
18. Call `computer` with action `double_click` on TAB_1 at coordinates `[640, 300]`.
19. Call `computer` with action `triple_click` on TAB_1 at coordinates `[640, 300]`.
20. Call `computer` with action `right_click` on TAB_1 at coordinates `[640, 300]`.
21. Call `computer` with action `type` on TAB_1 with text `"integration test"`.
22. Call `find` with query `"search"` on TAB_1 again, then `computer` with action `scroll_to` on TAB_1 with that ref.

## JavaScript + Debug
23. Call `javascript_tool` on TAB_1 with action `"javascript_exec"` and text `"document.querySelectorAll('a').length"`.
24. Call `read_console_messages` on TAB_1 with pattern `".*"`.
25. Call `read_network_requests` on TAB_1.
26. Call `javascript_tool` on TAB_1 with action `"javascript_exec"` and text `"const n = await Promise.resolve(document.title.length); n"` (top-level await should return a number).
27. Call `handle_dialog` on TAB_1 with `accept: true`, then `javascript_tool` on TAB_1 with action `"javascript_exec"` and text `"confirm('integration test')"`. Expected: `true`, with a note that the page opened a confirm dialog.
28. Call `debug` with `tabId` TAB_1 and `limit: 20`. (Expected: the latest tool calls on TAB_1, and which element the clicks reached.)

## Second Tab
29. Call `navigate` to go to `https://news.ycombinator.com` in TAB_2.
30. Call `computer` with action `screenshot` on TAB_2 with `save_to_disk: true`. (Expected: the result says where the image was saved.)
31. Call `set_tab_focus` on TAB_2. (Expected: TAB_2 is now the selected tab in its window.)

## Drag
32. Call `computer` with action `left_click_drag` on TAB_1 with start_coordinate `[100, 300]` and coordinate `[400, 300]`.

## Zoom
33. Call `computer` with action `zoom` on TAB_1 with region `[0, 0, 640, 400]`.

## Settings + human-like input
34. Call `get_config` with `tabId` TAB_1.
35. Call `set_config` with key `"humanize"`, value `true` and `tabId` TAB_1.
36. Call `computer` with action `hover` on TAB_1 at coordinates `[400, 300]`. (The mouse now takes a moment to get there.)
37. Call `set_config` with key `"humanize"`, value `null` and `tabId` TAB_1.

## Files
38. Call `navigate` to go to `https://example.com` in TAB_2, then `javascript_tool` on TAB_2 with action `"javascript_exec"` and text `"document.body.insertAdjacentHTML('beforeend', '<input type=\"file\" aria-label=\"Test upload\" hidden>'); 'added'"`.
39. Call `computer` with action `left_click` on TAB_2 at coordinates `[5, 300]`, in the empty margin left of the text. (Expected: the result says nothing was there but the page itself.)
40. Call `find` with query `"Test upload"` on TAB_2. (Expected: the file input, marked hidden.)
41. Call `upload_image` on TAB_2 with the imageId from your first screenshot (step 6) and the ref from step 40. (Expected: "Put screenshot.jpg in the file input".)
42. Call `file_upload` on TAB_2 with the ref from step 40 and `paths` set to the absolute path of any small file on this computer (for example this repository's `README.md`). The user is asked to confirm; either answer counts.

## Tools not available in Firefox (call them — each should return an error saying so)
43. Call `gif_creator` with action `"start_recording"` on TAB_1.
44. Call `shortcuts_list` on TAB_1.
45. Call `shortcuts_execute` on TAB_1 with command `"test"`.
46. Call `switch_browser`.

## Plan
47. Call `update_plan` with domains `["reddit.com", "news.ycombinator.com", "example.com"]` and approach `["Testing browser automation", "Validating all tools", "Checking parity with Claude in Chrome"]`.

## Shared tabs + closing
48. Call `tabs_request_access` with reason `"Integration test: share any tab, or choose Don't share"`. The user answers in Firefox; any answer counts.
49. If a tab was shared, call `tabs_request_handover` on it (the user answers in the app's prompt, or you ask them in the conversation if the result says so). Otherwise call `tabs_request_handover` on TAB_2 (expected: an error that it isn't shared).
50. Call `tabs_release` once: on a tab that's still shared if there is one, otherwise on TAB_2 (expected: a message that it's one of Claude's own tabs).
51. Call `tabs_close_mcp` with `tabIds` `[TAB_1, TAB_2]`. (Expected: both tabs close.)

## Validation

Now produce a final report. List every one of the 28 tools below and whether you successfully called it during this test. Use this exact format:

```
INTEGRATION TEST RESULTS
========================
1.  tabs_context_mcp         : [PASS/FAIL] — step(s) used
2.  tabs_create_mcp          : [PASS/FAIL] — step(s) used
3.  tabs_close_mcp           : [PASS/FAIL] — step(s) used
4.  set_tab_focus            : [PASS/FAIL] — step(s) used
5.  tabs_request_access      : [PASS/FAIL] — step(s) used
6.  tabs_request_handover    : [PASS/FAIL] — step(s) used
7.  tabs_release             : [PASS/FAIL] — step(s) used
8.  handle_dialog            : [PASS/FAIL] — step(s) used
9.  navigate                 : [PASS/FAIL] — step(s) used
10. computer                 : [PASS/FAIL] — step(s) used (list actions exercised)
11. find                     : [PASS/FAIL] — step(s) used
12. form_input               : [PASS/FAIL] — step(s) used
13. get_page_text            : [PASS/FAIL] — step(s) used
14. gif_creator              : [PASS/FAIL] — step(s) used
15. javascript_tool          : [PASS/FAIL] — step(s) used
16. read_console_messages    : [PASS/FAIL] — step(s) used
17. read_network_requests    : [PASS/FAIL] — step(s) used
18. read_page                : [PASS/FAIL] — step(s) used
19. resize_window            : [PASS/FAIL] — step(s) used
20. shortcuts_list           : [PASS/FAIL] — step(s) used
21. shortcuts_execute        : [PASS/FAIL] — step(s) used
22. switch_browser           : [PASS/FAIL] — step(s) used
23. update_plan              : [PASS/FAIL] — step(s) used
24. upload_image             : [PASS/FAIL] — step(s) used
25. file_upload              : [PASS/FAIL] — step(s) used
26. debug                    : [PASS/FAIL] — step(s) used
27. get_config               : [PASS/FAIL] — step(s) used
28. set_config               : [PASS/FAIL] — step(s) used

Computer actions exercised:
- screenshot: [PASS/FAIL]
- left_click: [PASS/FAIL]
- right_click: [PASS/FAIL]
- double_click: [PASS/FAIL]
- triple_click: [PASS/FAIL]
- hover: [PASS/FAIL]
- type: [PASS/FAIL]
- key: [PASS/FAIL]
- scroll: [PASS/FAIL]
- scroll_to: [PASS/FAIL]
- wait: [PASS/FAIL]
- left_click_drag: [PASS/FAIL]
- zoom: [PASS/FAIL]

OVERALL: [PASS if all 28 tools called / FAIL if any missed]
```

Mark a tool as PASS only if you actually called it and received a response (for the tools not available in Firefox, the error saying so counts). Mark it as FAIL if you skipped it or encountered an error that prevented the call.

If OVERALL is FAIL, list which tools failed and why.

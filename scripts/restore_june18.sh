#!/bin/bash
# Restore events and news from the June 18, 2026 brief PDF
# Usage: ./scripts/restore_june18.sh https://your-app.railway.app
#    or: ./scripts/restore_june18.sh http://localhost:3000

BASE="${1:-http://localhost:3000}"
echo "Restoring data to: $BASE"

echo ""
echo "=== Adding Event 1: Auto nagar inauguration ==="
curl -s -X POST "$BASE/api/schedule" \
  -H 'Content-Type: application/json' \
  -d '{
    "date": "2026-06-18",
    "event_name": "Auto nagar inauguration",
    "event_type": "Inauguration",
    "mandal": "Chilakaluripet",
    "village": "Near pothavaram village",
    "description": ""
  }' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Event ID: {d.get(\"event_id\",\"?\")} | Nearby contacts: {d.get(\"nearby_count\",0)}')" 2>/dev/null || echo "  (response received)"

echo ""
echo "=== Adding Event 2: Kutami rally ==="
curl -s -X POST "$BASE/api/schedule" \
  -H 'Content-Type: application/json' \
  -d '{
    "date": "2026-06-18",
    "event_name": "Kutami rally",
    "event_type": "Other",
    "mandal": "Vinukonda",
    "village": "Vinukonda town",
    "description": "Rally"
  }' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Event ID: {d.get(\"event_id\",\"?\")} | Nearby contacts: {d.get(\"nearby_count\",0)}')" 2>/dev/null || echo "  (response received)"

echo ""
echo "=== Adding Field News ==="

# Eenadu district news
curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"వేగంగా సర్ – 2 కోట్ల మంది డీటీటీ పొందారు","source":"Paper: Eenadu (ఈనాడు) | Edition: District | Date: గురువారం, జూన్ 18, 2026"}' > /dev/null
echo "  1. Eenadu - వేగంగా సర్ – 2 కోట్ల మంది డీటీటీ పొందారు"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"బీడు భూముల్లో పచ్చని విప్లవం (Green Revolution on Barren Lands)","source":"Paper: Eenadu (ఈనాడు) | Edition: District | Date: గురువారం, జూన్ 18, 2026"}' > /dev/null
echo "  2. Eenadu - బీడు భూముల్లో పచ్చని విప్లవం"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"వరకపూడిశెలకు తొలగిన అడంకులు (Obstacles Cleared for Development Project)","source":"Paper: Eenadu (ఈనాడు) | Edition: District | Date: గురువారం, జూన్ 18, 2026"}' > /dev/null
echo "  3. Eenadu - వరకపూడిశెలకు తొలగిన అడంకులు"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"విద్యార్థులు పాఠశాలలకు వెళ్తున్నారా? (Are Students Actually Attending School?)","source":"Field correspondent"}' > /dev/null
echo "  4. Field - విద్యార్థులు పాఠశాలలకు వెళ్తున్నారా?"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"Absurd step: Kerjriwal slams Modi government'\''s temporary ban on Telegram","source":"Field correspondent"}' > /dev/null
echo "  5. Field - Kerjriwal slams Modi on Telegram ban"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"Is Congress preparing for a Punjab shake-up? 66 leaders summoned to Delhi","source":"Field correspondent"}' > /dev/null
echo "  6. Field - Congress Punjab shake-up"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"How a Mohenjo-daro figurine became a '\''dancer'\'' — and associated with vulgarity","source":"Field correspondent"}' > /dev/null
echo "  7. Field - Mohenjo-daro figurine"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"White Paper addresses adverse impact of '\''revenue collapse'\'' on people of Tamil Nadu","source":"Field correspondent"}' > /dev/null
echo "  8. Field - Tamil Nadu White Paper"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"After China says no, exporters urge Andhra Pradesh to curb high-risk pesticides in chilli","source":"Field correspondent"}' > /dev/null
echo "  9. Field - AP chilli pesticides"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"Shiv Sena (UBT) Split Buzz","source":"TOI"}' > /dev/null
echo "  10. TOI - Shiv Sena split"

curl -s -X POST "$BASE/api/news" \
  -H 'Content-Type: application/json' \
  -d '{"headline":"G7 Summit Day 2 highlights: India always on side of peace, places humanity over everything else, says Modi","source":"Hindu"}' > /dev/null
echo "  11. Hindu - G7 Summit Modi"

echo ""
echo "=== Done! ==="
echo "Added 2 events and 11 news items for June 18, 2026."
echo "Visit $BASE/pa_schedule.html to see the events and prepare the brief."

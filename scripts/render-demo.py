"""Compose actual browser captures into a captioned, two-view demo video.

Frames are captured through the supported browser tool while playing a new
room. No gameplay state or screenshot content is synthesized by this script.
"""
import json
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'demo'
timeline = json.loads((OUT / 'timeline.json').read_text(encoding='utf-8'))
rendered = OUT / 'composed'
rendered.mkdir(exist_ok=True)
font_path = 'C:/Windows/Fonts/msyh.ttc'
font = lambda size: ImageFont.truetype(font_path, size)
total = sum(f['seconds'] for f in timeline)
elapsed = 0
concat = []
subtitles = []
def timestamp(t):
    millis = round(t * 1000)
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    seconds, millis = divmod(millis, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02},{millis:03}'

for number, item in enumerate(timeline):
    canvas = Image.new('RGB', (1920, 1080), '#eaece3')
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 94), fill='#233e35')
    draw.text((50, 20), '共行  /  双人 Puzzlehunt', font=font(36), fill='#f8f6ed')
    draw.text((1400, 31), '真实浏览器画面 · 占位试玩', font=font(22), fill='#c6d3be')
    for side, label, left, color in [('a', '玩家一 · 独立操作', 34, '#3d6d5a'), ('b', '玩家二 · 同一份存档', 980, '#aa7751')]:
        draw.rounded_rectangle((left, 108, left + 906, 956), radius=16, fill='#fbfaf4', outline='#cfd5c5', width=2)
        draw.ellipse((left + 20, 122, left + 34, 136), fill=color)
        draw.text((left + 48, 113), label, font=font(23), fill=color)
        shot = Image.open(OUT / 'frames' / f'{item["index"]}-{side}.png').convert('RGB')
        if shot.width > 1000:
            # Early captures use a wider viewport. Focus the visible entry or
            # game panel; later captures already have the narrow two-view size.
            if number == 0 or (number == 1 and side == 'b'):
                shot = shot.crop((700, 0, 1215, shot.height))
            else:
                shot = shot.crop((300, 80, shot.width - 20, shot.height))
        shot = ImageOps.contain(shot, (878, 790), Image.Resampling.LANCZOS)
        canvas.paste(shot, (left + (906-shot.width)//2, 151 + (790-shot.height)//2))
    draw.rectangle((0, 976, 1920, 1080), fill='#233e35')
    caption = item['caption']
    caption_font = font(31)
    width = draw.textbbox((0,0), caption, font=caption_font)[2]
    draw.text(((1920-width)//2, 995), caption, font=caption_font, fill='#fffdf1')
    draw.rectangle((0, 1067, int(1920 * (elapsed+item['seconds'])/total), 1073), fill='#c99e66')
    file = rendered / f'{item["index"]}.png'
    canvas.save(file)
    concat.append(f"file '{file.as_posix()}'\nduration {item['seconds']:.3f}\n")
    subtitles.append(f'{number+1}\n{timestamp(elapsed)} --> {timestamp(elapsed+item["seconds"])}\n{caption}\n')
    elapsed += item['seconds']

concat.append(f"file '{file.as_posix()}'\n")
(OUT / 'concat.txt').write_text(''.join(concat), encoding='utf-8')
(OUT / 'demo.zh-CN.srt').write_text('\n'.join(subtitles), encoding='utf-8')
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-y', '-f', 'concat', '-safe', '0', '-i', str(OUT/'concat.txt'), '-vf', 'fps=30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-t', f'{total:.3f}', str(OUT/'puzzlehunt-demo.mp4')], check=True)
# A few representative finished frames for manual video QA.
for index, name in [(15, 'independent-puzzles'), (19, 'rescue'), (48, 'final')]:
    if index < len(timeline):
        Image.open(rendered / f'{index:04}.png').save(OUT / f'{name}.jpg', quality=92)
print(f'Created {OUT / "puzzlehunt-demo.mp4"} ({total:.2f}s, 1920x1080, 30fps; real gameplay captures with edited timing).')

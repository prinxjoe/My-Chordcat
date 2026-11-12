import os, urllib.request

os.makedirs("samples/salamander", exist_ok=True)

# Tone.js
urllib.request.urlretrieve(
    "https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js", "Tone.js")

# Piano samples
notes = ["A0","C1","Ds1","Fs1","A1","C2","Ds2","Fs2","A2","C3","Ds3","Fs3","A3",
         "C4","Ds4","Fs4","A4","C5","Ds5","Fs5","A5","C6","Ds6","Fs6","A6",
         "C7","Ds7","Fs7","A7","C8"]
for n in notes:
    print("Downloading", n)
    urllib.request.urlretrieve(
        f"https://tonejs.github.io/audio/salamander/{n}.mp3",
        f"samples/salamander/{n}.mp3")
print("Done")
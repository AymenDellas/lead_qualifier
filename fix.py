import os
import shutil

for f in os.listdir('.'):
    if '\\' in f:
        new_path = f.replace('\\', '/')
        os.makedirs(os.path.dirname(new_path), exist_ok=True)
        shutil.move(f, new_path)
print("Fixed backslash filenames")

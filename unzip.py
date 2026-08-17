import zipfile
import os

zip_path = 'update.zip'
if os.path.exists(zip_path):
    with zipfile.ZipFile(zip_path, 'r') as zf:
        zf.extractall('.')
    print("Extracted successfully.")

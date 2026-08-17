import re

with open('src/components/Dashboard.tsx', 'r', encoding='utf-8') as f:
    code = f.read()

code = code.replace(
    "const [unbouncerInput, setUnbouncerInput] = useState('');",
    "const [unbouncerInput, setUnbouncerInput] = useState('');\n    const [unbouncerSourceMap, setUnbouncerSourceMap] = useState<Record<string, string>>({});"
)

with open('src/components/Dashboard.tsx', 'w', encoding='utf-8') as f:
    f.write(code)

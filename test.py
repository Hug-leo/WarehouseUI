import pyodbc

conn = pyodbc.connect(
"DRIVER={ODBC Driver 17 for SQL Server};"
"SERVER=LAPTOP-6CG6MGNS\\SQLEXPRESS;"
"DATABASE=WarehouseDB;"
"Trusted_Connection=yes;"
)

cursor = conn.cursor()

cursor.execute("SELECT * FROM Locations")

for row in cursor:
    print(row)